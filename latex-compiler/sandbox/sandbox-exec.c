/*
 * sandbox-exec — executa um comando do compilador LaTeX com privilégios mínimos.
 *
 * Roda como root (o serviço Node chama este binário) e, antes do execvp:
 *   1. cria uma sessão nova (setsid), para o serviço matar o grupo inteiro;
 *   2. aplica limites de recursos (CPU, memória, tamanho de arquivo, processos,
 *      descritores, core dump desligado);
 *   3. troca para o UID/GID do slot da compilação (sem grupos suplementares) —
 *      cada compilação simultânea tem o seu, então uma não lê os arquivos da
 *      outra, e nenhuma lê /proc/<pid>/environ do serviço;
 *   4. liga no_new_privs e instala um filtro seccomp que recusa sockets de rede
 *      (IPv4, IPv6, netlink, packet...), io_uring (contornaria o filtro),
 *      ptrace e leitura/escrita de memória de outros processos, criação de
 *      namespaces e montagens. Só sockets AF_UNIX continuam permitidos.
 *
 * O filtro não depende de namespaces nem de CAP_SYS_ADMIN: funciona dentro de
 * contêineres comuns (Docker, Railway). Qualquer falha aborta sem executar o
 * comando — nunca há execução "sem sandbox" por engano.
 *
 * Uso: sandbox-exec --uid N --gid N --cpu SEG --mem BYTES --fsize BYTES
 *                   --nproc N --nofile N -- comando [args...]
 */
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <linux/sched.h>
#include <seccomp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <unistd.h>

static void die(const char *what) {
  fprintf(stderr, "sandbox-exec: %s: %s\n", what, strerror(errno));
  _exit(126);
}

static unsigned long long parse_num(const char *flag, const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long n = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') {
    fprintf(stderr, "sandbox-exec: valor inválido para %s\n", flag);
    _exit(125);
  }
  return n;
}

static void set_limit(int resource, rlim_t value, const char *name) {
  struct rlimit rl = {value, value};
  if (setrlimit(resource, &rl) != 0) die(name);
}

static void deny(scmp_filter_ctx ctx, int syscall_nr, const char *name) {
  if (syscall_nr == __NR_SCMP_ERROR) return; /* syscall inexistente nesta arquitetura */
  if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), syscall_nr, 0) != 0) {
    fprintf(stderr, "sandbox-exec: seccomp %s\n", name);
    _exit(126);
  }
}

static void deny_socket_family(scmp_filter_ctx ctx, int syscall_nr, int family) {
  if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EACCES), syscall_nr, 1, SCMP_A0(SCMP_CMP_EQ, (scmp_datum_t)family)) != 0) {
    fprintf(stderr, "sandbox-exec: seccomp socket(%d)\n", family);
    _exit(126);
  }
}

static const int DENIED_FAMILIES[] = {AF_INET, AF_INET6, AF_NETLINK, AF_PACKET, AF_X25, AF_AX25,
                                      AF_APPLETALK, AF_IPX, AF_BLUETOOTH, AF_VSOCK, AF_ALG, AF_KEY,
                                      AF_TIPC, AF_RDS, AF_CAN, AF_XDP};

/* Um bit de namespace no primeiro argumento do clone => EPERM. */
static const scmp_datum_t NAMESPACE_FLAGS[] = {CLONE_NEWUSER, CLONE_NEWNS, CLONE_NEWNET, CLONE_NEWPID,
                                               CLONE_NEWIPC, CLONE_NEWUTS, CLONE_NEWCGROUP};

static void install_filter(void) {
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (!ctx) {
    fprintf(stderr, "sandbox-exec: seccomp_init\n");
    _exit(126);
  }
  /* Arquitetura não nativa (ex.: syscalls x86 de 32 bits) mata o processo. */
  if (seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS) != 0 ||
      seccomp_attr_set(ctx, SCMP_FLTATR_CTL_NNP, 1) != 0) {
    fprintf(stderr, "sandbox-exec: seccomp_attr_set\n");
    _exit(126);
  }

  /* Sockets: só AF_UNIX (usado por bibliotecas locais, ex.: fontconfig). */
  for (size_t i = 0; i < sizeof(DENIED_FAMILIES) / sizeof(DENIED_FAMILIES[0]); i++) {
    deny_socket_family(ctx, SCMP_SYS(socket), DENIED_FAMILIES[i]);
    deny_socket_family(ctx, SCMP_SYS(socketpair), DENIED_FAMILIES[i]);
  }

  deny(ctx, SCMP_SYS(io_uring_setup), "io_uring_setup");
  deny(ctx, SCMP_SYS(io_uring_enter), "io_uring_enter");
  deny(ctx, SCMP_SYS(io_uring_register), "io_uring_register");
  deny(ctx, SCMP_SYS(ptrace), "ptrace");
  deny(ctx, SCMP_SYS(process_vm_readv), "process_vm_readv");
  deny(ctx, SCMP_SYS(process_vm_writev), "process_vm_writev");
  deny(ctx, SCMP_SYS(unshare), "unshare");
  deny(ctx, SCMP_SYS(setns), "setns");
  deny(ctx, SCMP_SYS(mount), "mount");
  deny(ctx, SCMP_SYS(umount2), "umount2");
  deny(ctx, SCMP_SYS(pivot_root), "pivot_root");
  deny(ctx, SCMP_SYS(chroot), "chroot");
  deny(ctx, SCMP_SYS(bpf), "bpf");
  deny(ctx, SCMP_SYS(perf_event_open), "perf_event_open");
  deny(ctx, SCMP_SYS(keyctl), "keyctl");
  deny(ctx, SCMP_SYS(add_key), "add_key");
  deny(ctx, SCMP_SYS(request_key), "request_key");
  deny(ctx, SCMP_SYS(userfaultfd), "userfaultfd");
  deny(ctx, SCMP_SYS(kexec_load), "kexec_load");
  deny(ctx, SCMP_SYS(init_module), "init_module");
  deny(ctx, SCMP_SYS(finit_module), "finit_module");

  /* clone3 recebe as flags num struct (não dá para inspecionar): ENOSYS faz
     a libc cair para clone, cujo primeiro argumento é inspecionado. */
  if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(clone3), 0) != 0) {
    fprintf(stderr, "sandbox-exec: seccomp clone3\n");
    _exit(126);
  }
  for (size_t i = 0; i < sizeof(NAMESPACE_FLAGS) / sizeof(NAMESPACE_FLAGS[0]); i++) {
    if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1,
                         SCMP_A0(SCMP_CMP_MASKED_EQ, NAMESPACE_FLAGS[i], NAMESPACE_FLAGS[i])) != 0) {
      fprintf(stderr, "sandbox-exec: seccomp clone\n");
      _exit(126);
    }
  }

  if (seccomp_load(ctx) != 0) {
    fprintf(stderr, "sandbox-exec: seccomp_load falhou\n");
    _exit(126);
  }
  seccomp_release(ctx);
}

int main(int argc, char **argv) {
  long long uid = -1, gid = -1;
  unsigned long long cpu = 0, mem = 0, fsize = 0, nproc = 0, nofile = 0;
  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    }
    if (i + 1 >= argc) {
      fprintf(stderr, "sandbox-exec: falta o valor de %s\n", argv[i]);
      return 125;
    }
    const char *flag = argv[i];
    const char *value = argv[++i];
    if (strcmp(flag, "--uid") == 0) uid = (long long)parse_num(flag, value);
    else if (strcmp(flag, "--gid") == 0) gid = (long long)parse_num(flag, value);
    else if (strcmp(flag, "--cpu") == 0) cpu = parse_num(flag, value);
    else if (strcmp(flag, "--mem") == 0) mem = parse_num(flag, value);
    else if (strcmp(flag, "--fsize") == 0) fsize = parse_num(flag, value);
    else if (strcmp(flag, "--nproc") == 0) nproc = parse_num(flag, value);
    else if (strcmp(flag, "--nofile") == 0) nofile = parse_num(flag, value);
    else {
      fprintf(stderr, "sandbox-exec: opção desconhecida %s\n", flag);
      return 125;
    }
  }
  if (i >= argc) {
    fprintf(stderr, "sandbox-exec: nenhum comando\n");
    return 125;
  }
  /* Todos obrigatórios; UID/GID 0 recusados (a compilação nunca roda como root). */
  if (uid <= 0 || gid <= 0 || cpu == 0 || mem == 0 || fsize == 0 || nproc == 0 || nofile == 0) {
    fprintf(stderr, "sandbox-exec: --uid/--gid (não root), --cpu, --mem, --fsize, --nproc e --nofile são obrigatórios\n");
    return 125;
  }

  /* O Node (spawn detached) já pode ter criado a sessão: aí basta conferir. */
  if (setsid() < 0 && getsid(0) != getpid()) die("setsid");

  set_limit(RLIMIT_CORE, 0, "RLIMIT_CORE");
  set_limit(RLIMIT_CPU, (rlim_t)cpu, "RLIMIT_CPU");
  set_limit(RLIMIT_AS, (rlim_t)mem, "RLIMIT_AS");
  set_limit(RLIMIT_FSIZE, (rlim_t)fsize, "RLIMIT_FSIZE");
  set_limit(RLIMIT_NOFILE, (rlim_t)nofile, "RLIMIT_NOFILE");
  /* RLIMIT_NPROC conta processos do UID real: como cada slot tem o seu UID,
     o limite vale por compilação. */
  set_limit(RLIMIT_NPROC, (rlim_t)nproc, "RLIMIT_NPROC");

  if (setgroups(0, NULL) != 0) die("setgroups");
  if (setresgid((gid_t)gid, (gid_t)gid, (gid_t)gid) != 0) die("setresgid");
  if (setresuid((uid_t)uid, (uid_t)uid, (uid_t)uid) != 0) die("setresuid");
  /* Confere que não há volta para root. */
  if (setuid(0) == 0 || geteuid() == 0 || getuid() == 0) {
    fprintf(stderr, "sandbox-exec: não foi possível largar o root\n");
    _exit(126);
  }
  /* Se o serviço morrer, o comando morre junto (precisa vir depois da troca de UID). */
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) die("PR_SET_PDEATHSIG");

  install_filter();

  execvp(argv[i], &argv[i]);
  die("execvp");
  return 127;
}

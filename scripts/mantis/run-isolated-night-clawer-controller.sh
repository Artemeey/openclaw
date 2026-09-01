#!/usr/bin/env bash
set -euo pipefail

stage="${1:-}"
shift || true

require_uint() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

case "$stage" in
  --launch)
    [[ "$EUID" -eq 0 && "$#" -ge 7 ]]
    controller_uid="$1"
    controller_gid="$2"
    parent_pid="$3"
    runtime_root="$4"
    workdir="$5"
    shift 5
    [[ "${1:-}" == "--" ]]
    shift
    require_uint "$controller_uid"
    require_uint "$controller_gid"
    require_uint "$parent_pid"
    [[ "$controller_uid" -gt 0 && "$controller_uid" -ne "$(stat -c %u "/proc/$parent_pid")" ]]
    [[ -d "$runtime_root" && -d "$workdir" && "$#" -gt 0 ]]
    exec /usr/bin/unshare \
      --mount \
      --fork \
      --propagation private \
      "$0" --namespace \
      "$controller_uid" "$controller_gid" "$parent_pid" "$runtime_root" "$workdir" -- "$@"
    ;;

  --namespace)
    [[ "$EUID" -eq 0 && "$#" -ge 7 ]]
    controller_uid="$1"
    controller_gid="$2"
    parent_pid="$3"
    runtime_root="$4"
    workdir="$5"
    shift 5
    [[ "${1:-}" == "--" ]]
    shift
    mount -t proc proc /proc -o nosuid,nodev,noexec,hidepid=2
    exec /usr/bin/prlimit \
      --core=0:0 \
      --nproc=256:256 \
      -- \
      /usr/bin/setpriv \
        --reuid="$controller_uid" \
        --regid="$controller_gid" \
        --clear-groups \
        --no-new-privs \
        --inh-caps=-all \
        --ambient-caps=-all \
        --bounding-set=-all \
        --pdeathsig=KILL \
        /usr/bin/env -i \
          HOME="$runtime_root/home" \
          LANG=C.UTF-8 \
          PATH=/usr/local/bin:/usr/bin:/bin \
          TMPDIR="$runtime_root/tmp" \
          "$0" --runtime \
          "$controller_uid" "$controller_gid" "$parent_pid" "$runtime_root" "$workdir" -- "$@"
    ;;

  --runtime)
    [[ "$#" -ge 7 ]]
    controller_uid="$1"
    controller_gid="$2"
    parent_pid="$3"
    runtime_root="$4"
    workdir="$5"
    shift 5
    [[ "${1:-}" == "--" ]]
    shift
    status="$(cat /proc/self/status)"
    [[ "$(id -u)" == "$controller_uid" && "$(id -g)" == "$controller_gid" ]]
    [[ -z "$(awk '/^Groups:/{ $1=""; sub(/^ /, ""); print }' <<<"$status")" ]]
    grep -Eq '^NoNewPrivs:[[:space:]]+1$' <<<"$status"
    for capability in CapInh CapPrm CapEff CapBnd CapAmb; do
      grep -Eq "^${capability}:[[:space:]]+0+$" <<<"$status"
    done
    [[ "$(ulimit -Sc)" == "0" && "$(ulimit -Hc)" == "0" ]]
    for proc_path in environ mem fd cmdline; do
      [[ ! -e "/proc/$parent_pid/$proc_path" ]]
    done
    ! env | grep -Eq '^(OPENCLAW_QA_CONVEX_SECRET[^=]*|GITHUB_[^=]*|ACTIONS_[^=]*|RUNNER_[^=]*|NPM_TOKEN|NODE_AUTH_TOKEN)='
    while IFS= read -r fd_target; do
      [[ "$fd_target" != *'/_runner_file_commands/'* && "$fd_target" != *'/github/file_commands/'* ]]
    done < <(
      for fd in /proc/self/fd/*; do
        readlink "$fd" 2>/dev/null || true
      done
    )
    [[ "$(stat -c '%a:%u:%g' "$runtime_root")" == "770:$(stat -c %u "$runtime_root"):${controller_gid}" ]]
    [[ -d "$runtime_root/home" && -d "$runtime_root/tmp" ]]
    cd "$workdir"
    umask 007
    exec "$@"
    ;;

  *)
    exit 64
    ;;
esac

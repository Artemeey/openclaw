#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper_dir="${repo_root}/helper"
endpoint_contract="${repo_root}/helper-endpoint.json"
build_dir="${TMPDIR:-/tmp}/openclaw-facetime-macabi"
sdk_root="/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
clang_bin="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"
staged_dir="${HOME}/Library/Containers/com.apple.FaceTime/Data/tmp"
staged_dylib="${staged_dir}/FaceTimeHelper.dylib"
auth_dir="${HOME}/Library/Application Support/OpenClaw/FaceTime"
ipc_key_file="${auth_dir}/helper-ipc-key"
build_stamp_file="${auth_dir}/helper-build.sha256"
secret_header="${build_dir}/OpenClawFaceTimeHelperSecrets.h"
if_needed=false
check_only=false

cleanup() {
  if [[ -e "${secret_header}" ]]; then
    : > "${secret_header}"
    if [[ -x /usr/bin/trash ]]; then
      /usr/bin/trash "${secret_header}" >/dev/null 2>&1 || true
    else
      /usr/bin/python3 -c 'import os, sys; os.unlink(sys.argv[1])' "${secret_header}" \
        >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

if [[ "${1:-}" == "--if-needed" ]]; then
  if_needed=true
elif [[ "${1:-}" == "--check" ]]; then
  check_only=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--if-needed|--check]" >&2
  exit 2
fi

mkdir -p "${build_dir}"
if [[ "${check_only}" == true ]]; then
  ipc_key="$(printf '%064d' 0)"
else
  mkdir -p "${staged_dir}" "${auth_dir}"
  if [[ ! -s "${ipc_key_file}" ]]; then
    umask 077
    openssl rand -hex 32 > "${ipc_key_file}"
  fi
  ipc_key="$(tr -d '[:space:]' < "${ipc_key_file}")"
fi
if [[ ! "${ipc_key}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid FaceTime helper IPC key at ${ipc_key_file}" >&2
  exit 1
fi

source_hash="$(
  {
    find "${helper_dir}/FaceTimeHelper" -type f -print | LC_ALL=C sort | while IFS= read -r source_file; do
      shasum -a 256 "${source_file}"
    done
    shasum -a 256 "${BASH_SOURCE[0]}"
    shasum -a 256 "${endpoint_contract}"
    printf '%s' "${ipc_key}" | shasum -a 256
  } | shasum -a 256 | awk '{print $1}'
)"

if [[ "${if_needed}" == true &&
      -f "${staged_dylib}" &&
      -f "${build_stamp_file}" &&
      "$(tr -d '[:space:]' < "${build_stamp_file}")" == "${source_hash}" ]] &&
    codesign --verify --strict "${staged_dylib}" >/dev/null 2>&1; then
  echo "${staged_dylib}"
  exit 0
fi

umask 077
endpoint_host="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.host)' "${endpoint_contract}")"
endpoint_base_port="$(node -e 'const c=require(process.argv[1]); process.stdout.write(String(c.basePort))' "${endpoint_contract}")"
endpoint_max_port="$(node -e 'const c=require(process.argv[1]); process.stdout.write(String(c.maxPort))' "${endpoint_contract}")"
printf '#define OPENCLAW_FACETIME_HELPER_TOKEN "%s"\n#define OPENCLAW_FACETIME_HELPER_BUILD_ID "%s"\n#define OPENCLAW_FACETIME_HELPER_HOST @"%s"\n#define OPENCLAW_FACETIME_HELPER_BASE_PORT %s\n#define OPENCLAW_FACETIME_HELPER_MAX_PORT %s\n' \
  "${ipc_key}" "${source_hash}" "${endpoint_host}" "${endpoint_base_port}" "${endpoint_max_port}" > "${secret_header}"
chmod 600 "${secret_header}"

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer "${clang_bin}" \
  -target arm64e-apple-ios15.0-macabi \
  -dynamiclib \
  -isysroot "${sdk_root}" \
  -fobjc-arc \
  -fmodules \
  -include "${secret_header}" \
  -ObjC \
  -I "${helper_dir}/FaceTimeHelper" \
  -I "${helper_dir}/FaceTimeHelper/FaceTime" \
  -iframework /System/Library/PrivateFrameworks \
  "${helper_dir}/FaceTimeHelper/ConnectionAuthentication.m" \
  "${helper_dir}/FaceTimeHelper/FaceTimeHelper.m" \
  "${helper_dir}/FaceTimeHelper/NetworkController.m" \
  -framework Foundation \
  -framework CoreServices \
  -framework Security \
  -framework TelephonyUtilities \
  -o "${build_dir}/FaceTimeHelper.dylib"

if /usr/bin/strings -a "${build_dir}/FaceTimeHelper.dylib" | /usr/bin/grep -q 'FACETIMEHELPER:'; then
  echo "FaceTime helper release build contains debug logging strings" >&2
  exit 1
fi

codesign --force --sign - "${build_dir}/FaceTimeHelper.dylib"
if [[ "${check_only}" == true ]]; then
  codesign --verify --strict "${build_dir}/FaceTimeHelper.dylib"
  echo "${build_dir}/FaceTimeHelper.dylib"
  exit 0
fi
cp "${build_dir}/FaceTimeHelper.dylib" "${staged_dylib}"
codesign --force --sign - "${staged_dylib}"
printf '%s\n' "${source_hash}" > "${build_stamp_file}"

echo "${staged_dylib}"

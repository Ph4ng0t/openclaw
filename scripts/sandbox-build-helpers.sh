#!/usr/bin/env bash

append_sandbox_docker_build_args() {
  local -n _args_ref="$1"
  local build_network="${DOCKER_BUILD_NETWORK:-}"
  local proxy_var value

  if [[ -n "${build_network}" ]]; then
    _args_ref+=(--network "${build_network}")
  fi

  for proxy_var in \
    HTTP_PROXY \
    HTTPS_PROXY \
    ALL_PROXY \
    NO_PROXY \
    http_proxy \
    https_proxy \
    all_proxy \
    no_proxy
  do
    value="${!proxy_var:-}"
    if [[ -n "${value}" ]]; then
      _args_ref+=(--build-arg "${proxy_var}=${value}")
    fi
  done
}

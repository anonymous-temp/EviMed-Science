ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SOURCE_SHA
ARG OVERLAY_SHA
ARG KERNEL_VERSION
LABEL org.opencontainers.image.revision=${SOURCE_SHA} org.evimed.benchmark.overlay=${OVERLAY_SHA}
COPY . /benchmark-overlay/
RUN set -eu; \
    test "$(dsh --version)" = "$KERNEL_VERSION"; \
    seed=/opt/evimed/dsh-home-seed; \
    installed="$(readlink -f "$seed/profiles/evimed-runtime/node_modules/@evimed/dsh-socket")"; \
    test -f "$installed/package.json"; \
    for target in /opt/evimed/socket "$installed"; do \
      chmod -R u+w "$target"; \
      rm -rf "$target/src" "$target/plugins" "$target/extensions" "$target/capabilities" "$target/capability-skills"; \
      cp -a /benchmark-overlay/packages/socket/. "$target/"; \
      cp -a /benchmark-overlay/deploy/runtime-dsh/capabilities "$target/"; \
      cp -a /benchmark-overlay/capability-skills "$target/"; \
      for package in domain harness-port design-tokens; do \
        rm -rf "$target/node_modules/@evimed/$package"; \
        mkdir -p "$target/node_modules/@evimed"; \
        cp -a "/benchmark-overlay/packages/$package" "$target/node_modules/@evimed/"; \
      done; \
      cp /benchmark-overlay/scripts/runtime/validate-personal-skill.mjs "$target/scripts/"; \
      node "$target/scripts/build-client.mjs"; \
      test -s "$target/dist/client.js"; \
    done; \
    rm -rf /opt/evimed/mcp/evimed-research /opt/evimed/capabilities /opt/evimed/capability-skills; \
    cp -a /benchmark-overlay/runtime/mcp/evimed-research /opt/evimed/mcp/; \
    cp -a /benchmark-overlay/deploy/runtime-dsh/capabilities /opt/evimed/; \
    cp -a /benchmark-overlay/capability-skills /opt/evimed/; \
    chmod -R a-w /opt/evimed/socket "$installed" /opt/evimed/mcp /opt/evimed/capabilities /opt/evimed/capability-skills; \
    node /usr/local/bin/evimed-profile-seed.mjs seal "$seed" evimed-runtime; \
    chmod -R a-w "$seed"; \
    rm -rf /benchmark-overlay

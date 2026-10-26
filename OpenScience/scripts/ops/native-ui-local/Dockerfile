# Local acceptance only. BASE_IMAGE must contain an already verified,
# same-platform /app/harness/node_modules closure. This recipe is not the
# production image and is not itself acceptance evidence.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# Mount an installed checkout read-only at /repo and an empty owned volume at
# /acceptance. Invoke prepare-seed.mjs once before server.mjs using the same
# explicit opt-in, loopback origins, and EVIMED_ACCEPTANCE_KERNEL_MODULES.
WORKDIR /repo
ENTRYPOINT ["node", "/repo/scripts/ops/native-ui-local/server.mjs"]

# build-worker-image.mjs extracts only the selected runtime's public Node/Python binaries and system libraries.
FROM scratch
COPY rootfs/ /
COPY worker/ /opt/evimed/patient-matching-worker/
ENV PATH=/usr/local/bin:/usr/bin NODE_ENV=production PYTHONDONTWRITEBYTECODE=1
WORKDIR /opt/evimed/patient-matching-worker
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node", "src/server.mjs"]

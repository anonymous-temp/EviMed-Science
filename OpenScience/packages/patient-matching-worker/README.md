# Patient matching contained worker

Fixed JSON operations for exact clinical calculations, candidate rank fusion and
provider-order identity validation. It has no model client, provider credential,
agent loop or patient-store access. The host authorizes source-bound operations;
the native DSH plugin owns clinical interpretation.

`npm test` builds byte-identical copies of the research MCP's five calculator
modules and exercises the actual Python process. `npm pack` ships those generated
modules plus their SHA-256 inventory. The research MCP remains their sole source.

The service uses a private Unix socket (`PATIENT_MATCHING_WORKER_SOCKET`) and a
mode-600/400 token file (`PATIENT_MATCHING_WORKER_TOKEN_FILE`). It never exposes a
shell or an arbitrary Python expression. Credentials are reread for rotation.
Run the worker under a bounded container/process profile with no network and only
the socket directory and worker token mounted. It needs Node 22.22+ and Python 3.9+.

POST `/execute` accepts `{operation,input}` for `clinical-score`, `fuse` or
`permutation`. GET `/health` returns the worker identity. A missing operand returns
an explicit unsupported calculation and no fabricated value; the rest of a
matching task continues. Clinical source-grant checks belong to the host on both
dispatch and result readback.

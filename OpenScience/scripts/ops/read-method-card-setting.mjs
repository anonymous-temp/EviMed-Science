// May be piped into an existing control-plane container, including one that
// predates this diagnostic. Read only this setting; never load service secrets.
const key = "OPEN_SCIENCE_METHOD_CARD_EVIDENCE_ENABLED";
const raw = process.env[key];
const configured = raw !== undefined && raw !== "";
const enabled = configured && !["0", "false", "no", "off"].includes(raw.toLowerCase());
console.log(JSON.stringify({ setting: key, enabled, source: configured ? "environment" : "default" }));

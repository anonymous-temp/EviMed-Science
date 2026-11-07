# Virtual research suite

An optional DSH bundle for discovering visible virtual research tools and composing the domain plugins the host has already installed. It installs none of those plugins and confers no data access. Its `createSuite` API composes host-provided plugin instances and rejects overlapping method ownership. The suite does not itself implement scientific methods, cross-plugin object sharing, or a fixed research workflow.

The visible tools it lists include the trial plugin's virtual-laboratory tools (`virtual_trial_search`, `virtual_trial_compare`) when that plugin is installed; the laboratory itself runs on the hosted platform and needs no sibling plugin: an experiment's arms are named by method, and a disease-response arm is computed by the platform whether or not the patient plugin is installed. Package ids (`@evimed/virtual-cohort` and the others) are historical and unchanged; the names a person reads are the catalogue's `title` and `displayName`.

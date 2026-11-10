import { createPlugin as create } from '@evimed/research-plugin-runtime'
import { catalogue } from '@evimed/research-plugin-runtime/catalogue'
const entry = catalogue.find((item) => item.id === 'virtual-trial')
if (!entry) throw new Error('catalogue_entry_missing')
export const methods = entry.methods
/** @param {{adapter: import('@evimed/research-plugin-runtime').ResearchAdapter}} options */
export const createPlugin = ({ adapter }) => create({ adapter, methods })

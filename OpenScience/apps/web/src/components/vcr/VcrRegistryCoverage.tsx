import { knownErrorCodeMessage } from '@evimed/domain';
import type { VcrRegistrySource } from '@/lib/vcrClient';

/** Why a registry is left out, when the reason is the registry's own terms and not our work: the row says so. */
const LEFT_OUT_BY_TERMS = 'registry_terms_forbid_commercial_use';

/** Configuration and last observation are distinct from a successful empty search. */
export function VcrRegistryCoverage({ sources = [] }: { sources?: VcrRegistrySource[] }) {
  if (!sources.length) return null;
  return <section aria-label="注册源覆盖" className="space-y-2">
    <h3 className="text-ui font-medium text-text">注册源覆盖</h3>
    <ul className="space-y-1 text-caption text-text-2">
      {sources.map(source => <li key={source.key} className="flex flex-wrap gap-x-3 gap-y-1">
        <span>{source.label}</span>
        <span>{source.coverage === 'unsupported' ? '未接入' : source.coverage === 'list_only' ? '仅登记列表' : '结构化记录'}</span>
        {source.coverage === 'unsupported' && source.reason === LEFT_OUT_BY_TERMS && <span>{knownErrorCodeMessage(LEFT_OUT_BY_TERMS)}</span>}
        {source.coverage !== 'unsupported' && <span>{!source.configured ? '未配置' : source.availability === 'available' ? '上次读取成功' : source.availability === 'unavailable' ? '上次读取失败' : '尚未查询'}</span>}
      </li>)}
    </ul>
    {sources.some(source => source.coverage === 'list_only') && <p className="text-caption text-text-3">登记列表中的样本量未区分计划与实际，不能作为历史基线。</p>}
  </section>;
}

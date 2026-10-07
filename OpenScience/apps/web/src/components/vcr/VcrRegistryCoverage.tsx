import { knownErrorCodeMessage } from '@evimed/domain';
import type { VcrRegistrySource } from '@/lib/vcrClient';

/** Why a registry is left out, when the reason is the registry's own terms and not our work: the row says so. */
const LEFT_OUT_BY_TERMS = 'registry_terms_forbid_commercial_use';

/**
 * How far the registries reach, in one phrase from the sources' own fields — 「2 个来源可查，2 个仅列表或未接入」: a source is readable when it
 * is structured, configured and its last read did not fail; one that is list-only or not integrated is limited; a structured one that is
 * not configured or whose last read failed is out of reach for now. No prose is read, only the three closed fields.
 */
export function registryCoverageSummary(sources: readonly VcrRegistrySource[]): string {
  const limited = sources.filter(source => source.coverage !== 'structured').length;
  const readable = sources.filter(source => source.coverage === 'structured' && source.configured && source.availability !== 'unavailable').length;
  const down = sources.length - limited - readable;
  return [`${readable} 个来源可查`, limited ? `${limited} 个仅列表或未接入` : null, down ? `${down} 个暂时读不到` : null].filter(Boolean).join('，');
}

/** Configuration and last observation are distinct from a successful empty search. `heading: false` is for a caller that names the block itself (a Disclosure's summary). */
export function VcrRegistryCoverage({ sources = [], heading = true }: { sources?: VcrRegistrySource[]; heading?: boolean }) {
  if (!sources.length) return null;
  return <section aria-label="注册源覆盖" className="space-y-2">
    {heading && <h3 className="text-ui font-medium text-text">注册源覆盖</h3>}
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

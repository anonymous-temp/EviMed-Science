"""
PubMed NCBI E-utilities API 检索服务 V5.0
支持LLM驱动的多子查询并行检索
"""
import asyncio
import aiohttp
import xml.etree.ElementTree as ET
from typing import List, Dict, Any, Optional
from datetime import datetime
from collections import Counter
from models.schemas import LiteratureRecord, QueryTerms, EvidenceStats
import time
import logging

logger = logging.getLogger(__name__)



class PubMedSearchService:
    """PubMed NCBI E-utilities API 服务 V5.0"""

    BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

    def __init__(self):
        from config.settings import settings
        self.api_key = getattr(settings, 'NCBI_API_KEY', None)
        # 有API key时每秒最多10次，无API key时每秒最多3次
        self.min_interval = 0.11 if self.api_key else 0.4
        self._last_request_time = 0
        self._max_concurrent = getattr(settings, 'PUBMED_MAX_CONCURRENT', 8)
        self._semaphore = None  # 延迟初始化
        self._rate_lock = None  # 限速互斥锁
        self._session: Optional[aiohttp.ClientSession] = None  # 单例 session
        self._session_lock = None  # 初始化锁

    def _get_semaphore(self):
        """延迟获取Semaphore（必须在event loop内创建）"""
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(self._max_concurrent)
        return self._semaphore

    def _get_rate_lock(self):
        """延迟获取限速锁"""
        if self._rate_lock is None:
            self._rate_lock = asyncio.Lock()
        return self._rate_lock

    def _get_session_lock(self):
        if self._session_lock is None:
            self._session_lock = asyncio.Lock()
        return self._session_lock

    async def _get_session(self) -> aiohttp.ClientSession:
        """获取或创建单例 ClientSession（含连接池）"""
        if self._session is None or self._session.closed:
            async with self._get_session_lock():
                if self._session is None or self._session.closed:
                    connector = aiohttp.TCPConnector(
                        limit=20,          # 全局最大连接数
                        limit_per_host=10, # 同一 host 最大连接数
                        ttl_dns_cache=300  # DNS 缓存 5 分钟
                    )
                    self._session = aiohttp.ClientSession(connector=connector)
        return self._session

    async def close(self):
        """关闭 session，应在服务关闭时调用"""
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def _rate_limit(self):
        """频率限制控制 - 加锁确保并发协程串行通过限速检查"""
        async with self._get_rate_lock():
            current_time = time.time()
            elapsed = current_time - self._last_request_time
            if elapsed < self.min_interval:
                await asyncio.sleep(self.min_interval - elapsed)
            self._last_request_time = time.time()

    def _build_params(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """构建请求参数，自动附加API key"""
        if self.api_key:
            params["api_key"] = self.api_key
        return params

    # ==================== V5.0: 多子查询并行检索 ====================

    async def search_with_subqueries(
        self,
        sub_queries: List[str],
        max_results: int = 500,
        date_range: tuple = None
    ) -> List[LiteratureRecord]:
        """
        V5.0: 使用多个子查询并行检索PubMed

        Args:
            sub_queries: LLM生成的多个子查询
            max_results: 每个子查询的最大结果数
            date_range: (开始年份, 结束年份)，默认近5年

        Returns:
            合并去重后的文献记录列表
        """
        if not sub_queries:
            return []

        # 默认检索近5年
        if date_range is None:
            current_year = datetime.now().year
            date_range = (current_year - 4, current_year)

        logger.info(f"开始并行检索 {len(sub_queries)} 个子查询，时间范围: {date_range[0]}-{date_range[1]}...")

        # 并行执行所有子查询，设置整体超时防止服务卡死
        tasks = []
        for i, query in enumerate(sub_queries):
            task = self._search_single_query(query, max_results, query_index=i, date_range=date_range)
            tasks.append(task)

        _TOTAL_TIMEOUT = 180  # PubMed多子查询整体超时3分钟
        try:
            results_list = await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True),
                timeout=_TOTAL_TIMEOUT
            )
        except asyncio.TimeoutError:
            logger.warning(f"PubMed多子查询检索整体超时（>{_TOTAL_TIMEOUT}s），返回空列表")
            return []

        # 合并所有结果
        all_records = []
        seen_pmids = set()

        for i, result in enumerate(results_list):
            if isinstance(result, Exception):
                logger.warning(f"子查询 {i+1} 失败: {result}")
                continue

            logger.info(f"子查询 {i+1} 返回 {len(result)} 篇文献")
            for record in result:
                if record.pmid and record.pmid not in seen_pmids:
                    seen_pmids.add(record.pmid)
                    all_records.append(record)

        logger.info(f"去重后共 {len(all_records)} 篇文献")
        return all_records

    async def _search_single_query(
        self,
        query: str,
        max_results: int,
        query_index: int = 0,
        date_range: tuple = None
    ) -> List[LiteratureRecord]:
        """执行单个子查询检索（通过信号量限制并发数）"""
        async with self._get_semaphore():
            try:
                pmids = await self._esearch(query, max_results, date_range)
                if not pmids:
                    return []
                records = await self._efetch(pmids)
                return records
            except Exception as e:
                logger.warning(f"子查询 {query_index + 1} 执行失败: {e}")
                return []

    async def search(
        self,
        query_terms: QueryTerms,
        max_results: int = 500,
        date_range: tuple = None,
        sub_queries: List[str] = None
    ) -> List[LiteratureRecord]:
        """
        执行PubMed文献检索 - V5.0支持子查询

        Args:
            query_terms: 查询词（向后兼容）
            max_results: 最大返回结果数
            date_range: (开始年份, 结束年份) 可选
            sub_queries: V5.0新增，LLM生成的子查询列表

        Returns:
            文献记录列表
        """
        # V5.0: 如果提供了子查询，使用新的多子查询检索
        if sub_queries:
            return await self.search_with_subqueries(sub_queries, max_results)

        # 向后兼容：使用旧的查询构建方式
        query = self._build_query(query_terms)
        logger.info(f"PubMed检索查询: {query}")

        try:
            pmids = await self._esearch(query, max_results, date_range)
            logger.info(f"找到 {len(pmids)} 篇文献")

            if not pmids:
                return []

            records = await self._efetch(pmids)
            logger.info(f"成功获取 {len(records)} 篇文献详情")

            return records

        except Exception as e:
            logger.error(f"PubMed检索失败: {e}")
            import traceback
            traceback.print_exc()
            return []

    def _build_query(self, query_terms: QueryTerms) -> str:
        """构建PubMed查询字符串 - 向后兼容"""
        terms = []

        if query_terms.en:
            terms.extend(query_terms.en[:5])

        if query_terms.zh and not terms:
            terms.extend(query_terms.zh[:3])

        # V5.0: 改进查询构建逻辑
        if len(terms) >= 2:
            # 使用更合理的AND/OR组合
            main_terms = terms[:2]
            synonym_terms = terms[2:] if len(terms) > 2 else []

            query = f"({main_terms[0]}[Title/Abstract] AND {main_terms[1]}[Title/Abstract])"

            if synonym_terms:
                synonyms_query = " OR ".join([f"{t}[Title/Abstract]" for t in synonym_terms[:3]])
                query = f"({query}) AND ({synonyms_query})"
        elif len(terms) == 1:
            query = f"{terms[0]}[Title/Abstract]"
        else:
            query = ""

        return query

    async def _esearch(
        self,
        query: str,
        max_results: int,
        date_range: tuple = None
    ) -> List[str]:
        """使用esearch获取文献ID列表（含429重试和超时）"""
        params = self._build_params({
            "db": "pubmed",
            "term": query,
            "retmax": min(max_results, 10000),
            "retmode": "json",
            "sort": "date"
        })
        if date_range:
            params["mindate"] = f"{date_range[0]}/01/01"
            params["maxdate"] = f"{date_range[1]}/12/31"

        timeout = aiohttp.ClientTimeout(total=30)
        for attempt in range(3):
            try:
                await self._rate_limit()
                session = await self._get_session()
                async with session.get(
                    f"{self.BASE_URL}/esearch.fcgi", params=params,
                    timeout=timeout
                ) as resp:
                    if resp.status == 429:
                        wait = 2 ** (attempt + 1)
                        logger.warning(f"PubMed 限流(429), {wait}s 后重试...")
                        await asyncio.sleep(wait)
                        continue
                    if resp.status != 200:
                        raise Exception(f"esearch请求失败: {resp.status}")
                    data = await resp.json()
                    return data.get("esearchresult", {}).get("idlist", [])
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                logger.warning(f"esearch网络错误(attempt {attempt+1}): {e}")
                if attempt == 2:
                    raise
                await asyncio.sleep(2 ** attempt)
        return []

    async def _efetch(self, pmids: List[str]) -> List[LiteratureRecord]:
        """使用efetch获取文献详细信息（含重试和超时）"""
        batch_size = 200
        all_records = []
        timeout = aiohttp.ClientTimeout(total=60)

        for i in range(0, len(pmids), batch_size):
            batch_pmids = pmids[i:i + batch_size]
            pmid_str = ",".join(batch_pmids)

            params = self._build_params({
                "db": "pubmed",
                "id": pmid_str,
                "retmode": "xml"
            })

            for attempt in range(3):
                try:
                    await self._rate_limit()
                    session = await self._get_session()
                    async with session.get(
                        f"{self.BASE_URL}/efetch.fcgi", params=params,
                        timeout=timeout
                    ) as resp:
                        if resp.status == 429:
                            wait = 2 ** (attempt + 1)
                            logger.warning(f"PubMed efetch 限流(429), {wait}s 后重试...")
                            await asyncio.sleep(wait)
                            continue
                        if resp.status != 200:
                            logger.warning(f"efetch批次 {i//batch_size+1} 请求失败: {resp.status}")
                            break
                        xml_text = await resp.text()
                        records = await asyncio.to_thread(self._parse_pubmed_xml, xml_text)
                        all_records.extend(records)
                        break
                except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                    logger.warning(f"efetch网络错误(attempt {attempt+1}): {e}")
                    if attempt == 2:
                        logger.error(f"efetch批次 {i//batch_size+1} 最终失败: {e}")
                    else:
                        await asyncio.sleep(2 ** attempt)

            if i + batch_size < len(pmids):
                await asyncio.sleep(0.5)

        return all_records

    def _parse_pubmed_xml(self, xml_text: str) -> List[LiteratureRecord]:
        """解析PubMed XML返回结果"""
        records = []

        try:
            root = ET.fromstring(xml_text)

            for article in root.findall(".//PubmedArticle"):
                try:
                    record = self._parse_article(article)
                    if record:
                        records.append(record)
                except Exception as e:
                    logger.warning(f"解析单篇文章失败: {e}")
                    continue

        except ET.ParseError as e:
            logger.error(f"XML解析失败: {e}")

        return records

    def _parse_article(self, article_elem: ET.Element) -> Optional[LiteratureRecord]:
        """解析单篇文献"""
        try:
            # PMID
            pmid_elem = article_elem.find(".//PMID")
            pmid = pmid_elem.text if pmid_elem is not None else ""

            # 标题（用 itertext 处理含子标签如 <i>/<b> 的标题）
            title_elem = article_elem.find(".//ArticleTitle")
            title = "".join(title_elem.itertext()).strip() if title_elem is not None else ""
            title = title or "Unknown Title"

            # 摘要（用 itertext 处理含子标签的摘要段落）
            abstract_elems = article_elem.findall(".//AbstractText")
            abstract = " ".join(["".join(e.itertext()).strip() for e in abstract_elems]) if abstract_elems else ""

            # 作者
            authors = []
            author_elems = article_elem.findall(".//Author")
            for author in author_elems:
                lastname = author.find("LastName")
                forename = author.find("ForeName")
                if lastname is not None:
                    name = lastname.text
                    if forename is not None:
                        name = f"{forename.text} {name}"
                    authors.append(name)

            # 期刊
            journal_elem = article_elem.find(".//Journal/Title")
            journal = journal_elem.text if journal_elem is not None else ""

            # 发表年份
            year_elem = article_elem.find(".//PubDate/Year")
            if year_elem is None:
                medline_date = article_elem.find(".//PubDate/MedlineDate")
                if medline_date is not None:
                    year_text = medline_date.text[:4]
                    year = int(year_text) if year_text.isdigit() else None
                else:
                    year = None
            else:
                year = int(year_elem.text) if year_elem.text and year_elem.text.isdigit() else None

            # DOI
            doi_elem = article_elem.find(".//ArticleId[@IdType='doi']")
            doi = doi_elem.text if doi_elem is not None else None

            # 关键词
            keywords = []
            keyword_elems = article_elem.findall(".//Keyword")
            for kw in keyword_elems:
                if kw.text:
                    keywords.append(kw.text)

            # Mesh terms
            mesh_terms = []
            mesh_elems = article_elem.findall(".//DescriptorName")
            for mesh in mesh_elems:
                if mesh.text:
                    mesh_terms.append(mesh.text)

            # 研究类型识别
            publication_types = article_elem.findall(".//PublicationType")
            study_design = self._identify_study_design(
                publication_types,
                mesh_terms=mesh_terms,
                abstract=abstract,
                title=title,
            )
            is_clinical = study_design in [
                'RCT', 'Cohort', 'Case-Control', 'Meta-analysis', 'Systematic Review',
                'Clinical Trial', 'Clinical Study', 'Cross-sectional', 'Comparative Study',
                'Quasi-experimental',
            ]

            return LiteratureRecord(
                id=f"pubmed_{pmid}",
                title=title,
                abstract=abstract[:2000] if abstract else None,
                authors=authors[:10],
                journal=journal,
                publication_year=year,
                doi=doi,
                pmid=pmid,
                keywords=keywords[:10],
                mesh_terms=mesh_terms[:10],
                study_design=study_design,
                is_clinical=is_clinical,
                language="en",
                citations=0
            )

        except Exception as e:
            logger.warning(f"解析文章失败: {e}")
            return None

    def _identify_study_design(
        self,
        pub_types: List[ET.Element],
        mesh_terms: List[str] = None,
        abstract: str = None,
        title: str = None,
    ) -> str:
        """识别研究设计类型"""
        type_texts = [pt.text.lower() if pt.text else "" for pt in pub_types]
        mesh_terms_lower = [m.lower() for m in (mesh_terms or [])]
        abstract_lower = (abstract or "").lower()
        title_lower = (title or "").lower()
        combined = title_lower + " " + abstract_lower

        # 1. 基于PublicationTypeList识别
        if any('meta-analysis' in t for t in type_texts):
            return 'Meta-analysis'
        elif any('systematic review' in t for t in type_texts):
            return 'Systematic Review'
        elif any('randomized controlled trial' in t for t in type_texts):
            return 'RCT'
        elif any('clinical trial' in t for t in type_texts):
            return 'Clinical Trial'
        elif any('review' in t for t in type_texts):
            return 'Review'
        elif any('case report' in t for t in type_texts):
            return 'Case Report'
        elif any('comparative study' in t for t in type_texts):
            return 'Comparative Study'

        # 2. 基于MeSH Terms识别
        has_animals = 'animals' in mesh_terms_lower
        has_humans = 'humans' in mesh_terms_lower

        if has_animals and not has_humans:
            return 'Animal Study'

        # 3. 基于标题和摘要的明确设计 cue 识别。先识别协议和综述，
        # 避免把协议误当已完成试验、把提到 in-vitro 的临床研究误当体外实验。
        if 'protocol' in title_lower or 'study protocol' in abstract_lower:
            return 'Protocol'
        if 'meta-analysis' in combined:
            return 'Meta-analysis'
        if 'systematic review' in combined:
            return 'Systematic Review'
        if any(term in combined for term in ['randomized controlled', 'randomised controlled', 'randomized trial', 'randomised trial']):
            return 'RCT'
        if any(term in title_lower for term in ['cross-sectional', 'cross sectional', 'survey']):
            return 'Cross-sectional'
        if any(term in title_lower for term in ['before-after', 'before and after', 'pre-post', 'quality improvement']):
            return 'Quasi-experimental'

        if any(term in combined for term in ['cohort', 'registry', 'retrospective', 'prospective']):
            if has_humans or not has_animals:
                return 'Cohort'

        if any(term in combined for term in ['case-control', 'case control']):
            return 'Case-Control'

        human_cues = any(term in combined for term in [
            'patient', 'patients', 'participant', 'participants', 'intensive care',
            'hospital', 'electronic health record', 'therapeutic drug monitoring',
        ]) or has_humans
        if (
            any(term in title_lower for term in ['in vitro', 'cell line', 'cell culture'])
            or (not human_cues and any(term in abstract_lower for term in ['in vitro study', 'cell line', 'cell culture']))
        ):
            return 'In Vitro'

        if any(term in title_lower for term in [
            'population pharmacokinetic', 'pharmacokinetic-pharmacodynamic',
            'pharmacokinetic/pharmacodynamic', 'target attainment', 'monte carlo simulation',
        ]):
            return 'Pharmacometric Study'
        if any(term in title_lower for term in [
            'quantitative method', 'analytical method', 'assay', 'chromatography and mass spectrometry',
        ]):
            return 'Methods Study'

        # 4. 默认分类
        if human_cues:
            return 'Clinical Study'
        elif has_animals:
            return 'Animal Study'
        else:
            return 'Other'

    async def calculate_evidence_stats(
        self,
        records: List[LiteratureRecord]
    ) -> EvidenceStats:
        """计算证据统计 - V5.0增强"""
        if not records:
            return EvidenceStats(
                evidence_count=0,
                clinical_ratio=0.0,
                year_span=0,
                keyword_diversity=0.0,
                earliest_year=datetime.now().year,
                latest_year=datetime.now().year,
                design_distribution={},
                year_counts={},
                author_counts={},
                journal_counts={}
            )

        # 基础统计
        evidence_count = len(records)

        # 临床研究比例
        clinical_count = sum(1 for r in records if r.is_clinical)
        clinical_ratio = clinical_count / evidence_count if evidence_count > 0 else 0.0

        # 时间跨度
        years = [r.publication_year for r in records if r.publication_year]
        earliest_year = min(years) if years else datetime.now().year
        latest_year = max(years) if years else datetime.now().year
        year_span = latest_year - earliest_year

        # 年度发文量统计 (V5.0新增)
        year_counts = Counter(years)

        # 关键词多样性
        all_keywords = []
        for r in records:
            all_keywords.extend(r.keywords)
            all_keywords.extend(r.mesh_terms)

        unique_keywords = len(set(all_keywords))
        total_keyword_instances = len(all_keywords)
        keyword_diversity = (
            unique_keywords / total_keyword_instances
            if total_keyword_instances > 0 else 0.0
        )

        # 研究设计分布
        design_distribution = {}
        for r in records:
            design = r.study_design or 'Other'
            design_distribution[design] = design_distribution.get(design, 0) + 1

        # V5.0新增：作者和期刊统计
        author_counts = Counter()
        for r in records:
            for author in r.authors[:3]:  # 只统计前3作者
                author_counts[author] += 1

        journal_counts = Counter(r.journal for r in records if r.journal)

        return EvidenceStats(
            evidence_count=evidence_count,
            clinical_ratio=clinical_ratio,
            year_span=year_span,
            keyword_diversity=keyword_diversity,
            earliest_year=earliest_year,
            latest_year=latest_year,
            design_distribution=design_distribution,
            year_counts=dict(year_counts),
            author_counts=dict(author_counts.most_common(20)),
            journal_counts=dict(journal_counts.most_common(20))
        )

    async def deduplicate_records(
        self,
        records: List[LiteratureRecord]
    ) -> List[LiteratureRecord]:
        """Deduplicate without discarding DOI-only or internal evidence.

        PubMed records win when the same DOI/title appears in both sources,
        because their publication types and identifiers are authoritative.
        """
        import re

        def normalized(value: str) -> str:
            return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())

        def key(record: LiteratureRecord) -> str:
            if record.pmid:
                return "pmid:" + record.pmid
            if record.doi:
                return "doi:" + record.doi.strip().casefold().removeprefix("https://doi.org/")
            title = normalized(record.title)
            return "title:" + title if title else "id:" + record.id

        # Prefer PubMed metadata first, then retain unique internal records.
        ordered = sorted(records, key=lambda r: (not str(r.id).startswith("pubmed_"), not bool(r.pmid)))
        unique: dict[str, LiteratureRecord] = {}
        doi_index: dict[str, str] = {}
        title_index: dict[str, str] = {}
        for record in ordered:
            primary = key(record)
            doi_key = record.doi.strip().casefold().removeprefix("https://doi.org/") if record.doi else ""
            title_key = normalized(record.title)
            existing_key = (
                doi_index.get(doi_key) if doi_key else None
            ) or (title_index.get(title_key) if title_key else None)
            if existing_key or primary in unique:
                continue
            unique[primary] = record
            if doi_key:
                doi_index[doi_key] = primary
            if title_key:
                title_index[title_key] = primary

        return list(unique.values())

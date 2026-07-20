"""
LLM服务模块 V5.0 - LLM驱动的查询生成与扩展
处理所有与LLM的交互，实现三步走查询生成流程
新增：安全JSON解析、动态领域适配、LLM驱动同义词扩展
"""
import asyncio
import json
import os
import re
import stat
import logging
import time
from pathlib import Path
from typing import Optional, Dict, Any, List, AsyncGenerator
import httpx
from openai import AsyncOpenAI, AuthenticationError
from tenacity import retry, stop_after_attempt, wait_exponential
from config.settings import settings
from utils import safe_parse_json

logger = logging.getLogger(__name__)


class _JsonFieldExtractor:
    """从流式 JSON token 中实时提取指定字段字符串值，转发给 callback。"""

    def __init__(self, field_name: str, callback):
        self._marker = f'"{field_name}"'
        self._cb = callback
        self._buf = ""
        self._full = ""
        # SCAN → COLON → VALUE → DONE
        self._state = "SCAN"
        self._escape = False

    async def feed(self, delta: str) -> None:
        self._full += delta
        if self._state == "DONE":
            return
        self._buf += delta

        if self._state == "SCAN":
            idx = self._buf.find(self._marker)
            if idx != -1:
                self._buf = self._buf[idx + len(self._marker):]
                self._state = "COLON"

        if self._state == "COLON":
            # skip whitespace and ':'
            while self._buf and self._buf[0] in (' ', '\t', '\n', '\r', ':'):
                self._buf = self._buf[1:]
            if self._buf:
                if self._buf[0] == '"':
                    self._buf = self._buf[1:]
                    self._state = "VALUE"
                elif self._buf[0] == 'n':   # null
                    self._state = "DONE"
                    return

        if self._state == "VALUE":
            out = []
            i = 0
            while i < len(self._buf):
                c = self._buf[i]
                if self._escape:
                    self._escape = False
                    if c == 'n':
                        out.append('\n')
                    elif c == 't':
                        out.append('\t')
                    elif c == 'r':
                        out.append('\r')
                    elif c == '"':
                        out.append('"')
                    elif c == '\\':
                        out.append('\\')
                    elif c == '/':
                        out.append('/')
                    else:
                        out.append(c)
                elif c == '\\':
                    self._escape = True
                elif c == '"':
                    self._state = "DONE"
                    self._buf = self._buf[i + 1:]
                    i = len(self._buf)
                    break
                else:
                    out.append(c)
                i += 1
            if self._state != "DONE":
                self._buf = ""
            if out:
                await self._cb(''.join(out))

    @property
    def full_text(self) -> str:
        return self._full


class LLMService:
    """LLM服务 V5.0 - 支持LLM驱动的查询理解与生成"""

    # 医学同义词词典 - V5.0新增
    MEDICAL_SYNONYMS = {
        # 药物
        'rituximab': ['rituximab', 'rituxan', 'mabthera', '美罗华', '利妥昔单抗'],
        'cyclophosphamide': ['cyclophosphamide', 'ctx', '环磷酰胺'],
        'mycophenolate': ['mycophenolate', 'mmf', 'mycophenolate mofetil', '霉酚酸酯'],
        'tacrolimus': ['tacrolimus', 'fk506', '他克莫司'],
        'cyclosporine': ['cyclosporine', '环孢素', '环孢菌素'],
        'prednisone': ['prednisone', '强的松', '泼尼松'],
        'methylprednisolone': ['methylprednisolone', '甲强龙', '甲基强的松龙'],

        # 疾病
        'membranous nephropathy': ['membranous nephropathy', 'mn', '膜性肾病', '膜性肾小球肾炎'],
        'nephrotic syndrome': ['nephrotic syndrome', 'ns', '肾病综合征'],
        'minimal change disease': ['minimal change disease', 'mcd', '微小病变肾病'],
        'fsgs': ['fsgs', 'focal segmental glomerulosclerosis', '局灶节段性肾小球硬化'],
        'lupus nephritis': ['lupus nephritis', 'ln', '狼疮性肾炎'],
        'iga nephropathy': ['iga nephropathy', 'igan', 'iga肾病', 'iga肾小球肾炎'],
        'anca vasculitis': ['anca vasculitis', 'anca associated vasculitis', 'anca相关性血管炎'],
        'diabetic nephropathy': ['diabetic nephropathy', 'dn', '糖尿病肾病'],
        'aki': ['aki', 'acute kidney injury', '急性肾损伤'],
        'ckd': ['ckd', 'chronic kidney disease', '慢性肾脏病'],
        'esrd': ['esrd', 'end stage renal disease', '终末期肾病'],

        # 研究类型
        'rct': ['randomized controlled trial', 'rct', '随机对照试验'],
        'cohort': ['cohort study', 'prospective cohort', 'retrospective cohort', '队列研究'],
        'meta-analysis': ['meta-analysis', 'systematic review', '荟萃分析', '系统评价'],
        'case-control': ['case-control study', 'case control', '病例对照研究'],

        # 机制/指标
        'proteinuria': ['proteinuria', 'albuminuria', '蛋白尿'],
        'remission': ['remission', 'complete remission', 'partial remission', '缓解'],
        'relapse': ['relapse', 'recurrence', '复发'],
        'b cells': ['b cells', 'b lymphocytes', 'b淋巴细胞'],
        'cd20': ['cd20', 'ms4a1'],
        'antibodies': ['antibodies', 'autoantibodies', 'igg', 'igm'],
        'complement': ['complement', 'c3', 'c4', 'c5b-9', '补体'],
        'plar': ['plar2', 'plar', 'phospholipase a2 receptor', '磷脂酶a2受体'],
        'thsd7a': ['thsd7a', 'thrombospondin type 1 domain containing 7a'],

        # 治疗相关
        'treatment': ['treatment', 'therapy', 'management', '治疗'],
        'efficacy': ['efficacy', 'effectiveness', 'response', '疗效'],
        'safety': ['safety', 'adverse effects', 'side effects', 'toxicity', '安全性', '不良反应'],
        'immunosuppression': ['immunosuppression', 'immunosuppressive therapy', '免疫抑制'],
        'mechanism': ['mechanism', 'pathway', 'pathogenesis', '机制', '通路'],
    }

    def __init__(self):
        self.client = None
        self._client_api_key = None
        self._credential_refresh_lock = asyncio.Lock()
        self.flash_model = settings.DEEPSEEK_FLASH_MODEL
        self.pro_model = settings.DEEPSEEK_PRO_MODEL
        self.temperature = settings.LLM_TEMPERATURE
        self.max_tokens = settings.LLM_MAX_TOKENS
        self._request_semaphore = asyncio.Semaphore(max(1, settings.LLM_MAX_CONCURRENT))
        if settings.DEEPSEEK_API_KEY:
            self.client = self._new_client(settings.DEEPSEEK_API_KEY, settings.DEEPSEEK_BASE_URL)
            self._client_api_key = settings.DEEPSEEK_API_KEY
            logger.info(
                "DeepSeek服务已初始化: flash=%s pro=%s base_url=%s",
                self.flash_model,
                self.pro_model,
                settings.DEEPSEEK_BASE_URL,
            )

    @staticmethod
    def _new_client(api_key: str, base_url: str):
        return AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            http_client=httpx.AsyncClient(trust_env=False),
            max_retries=0,
        )

    @staticmethod
    def _managed_credentials() -> Optional[tuple[str, str]]:
        """Read a rotated gateway credential from the platform-owned config."""
        raw = os.environ.get("EVIMED_MODEL_CONFIG_FILE", "").strip()
        if not raw or not os.path.isabs(raw) or "\0" in raw:
            return None
        path = Path(raw)
        if path.is_symlink():
            return None
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError:
            return None
        try:
            stat_result = os.fstat(descriptor)
            if (
                not stat.S_ISREG(stat_result.st_mode)
                or stat_result.st_size <= 0
                or stat_result.st_size > 1024 * 1024
            ):
                return None
            payload = os.read(descriptor, stat_result.st_size + 1)
        finally:
            os.close(descriptor)
        try:
            config = json.loads(payload.decode("utf-8"))
            options = config["provider"]["deepseek"]["options"]
            api_key = options["apiKey"]
            base_url = options["baseURL"]
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        if (
            not isinstance(api_key, str)
            or not api_key
            or not isinstance(base_url, str)
            or not base_url.startswith(("http://", "https://"))
        ):
            return None
        return api_key, base_url.rstrip("/")

    async def _refresh_managed_client(self, failed_client) -> bool:
        """Adopt one platform rotation; never retry a 401 with unchanged credentials."""
        async with self._credential_refresh_lock:
            if self.client is not failed_client:
                return True
            credentials = self._managed_credentials()
            if not credentials:
                return False
            api_key, base_url = credentials
            if api_key == self._client_api_key:
                return False
            previous = self.client
            self.client = self._new_client(api_key, base_url)
            self._client_api_key = api_key
            close = getattr(previous, "close", None)
            if close is not None:
                try:
                    closed = close()
                    if asyncio.iscoroutine(closed):
                        await closed
                except Exception:  # pragma: no cover - cleanup cannot invalidate a fresh credential
                    logger.warning("Previous model client could not be closed after credential rotation.")
            logger.info("Managed model gateway credential rotation was adopted.")
            return True

    async def _create_completion_with_refresh(self, kwargs: Dict[str, Any], timeout: int):
        failed_client = self.client
        try:
            return await asyncio.wait_for(
                failed_client.chat.completions.create(**kwargs),
                timeout=timeout,
            )
        except AuthenticationError:
            if not await self._refresh_managed_client(failed_client):
                raise
            return await asyncio.wait_for(
                self.client.chat.completions.create(**kwargs),
                timeout=timeout,
            )
        else:
            logger.warning(
                "未配置DEEPSEEK_API_KEY，LLM服务将使用Mock模式。"
                "请在.env文件中设置DEEPSEEK_API_KEY（参考.env.example）"
            )

    def model_for_tier(self, model_tier: str = "pro") -> str:
        """按任务复杂度选择 DeepSeek V4 模型。"""
        if model_tier == "flash":
            return self.flash_model
        if model_tier == "pro":
            return self.pro_model
        raise ValueError(f"不支持的DeepSeek模型层级: {model_tier}")

    def _resolve_model(self, model: Optional[str], model_tier: str) -> tuple[str, str]:
        selected = model or self.model_for_tier(model_tier)
        # A managed deployment may intentionally route both tiers to the only
        # configured Pro model. In that case preserve Pro request semantics
        # (thinking enabled, reasoning effort, timeout and token reserve).
        if self.flash_model == self.pro_model and selected == self.pro_model:
            return selected, "pro"
        if selected == self.flash_model:
            return selected, "flash"
        if selected == self.pro_model:
            return selected, "pro"
        raise ValueError(f"不支持的DeepSeek模型: {selected}")

    def _effective_max_tokens(self, model: str, answer_tokens: int) -> int:
        """为 Pro 推理过程预留输出空间。"""
        if model != self.pro_model:
            return answer_tokens
        return min(
            settings.DEEPSEEK_MAX_OUTPUT_TOKENS,
            max(
                answer_tokens * 2,
                answer_tokens + settings.DEEPSEEK_PRO_REASONING_RESERVE_TOKENS,
            ),
        )

    def _request_kwargs(
        self,
        *,
        messages: List[Dict[str, str]],
        model: Optional[str],
        model_tier: str,
        temperature: float,
        max_tokens: int,
        json_mode: bool,
        stream: bool,
    ) -> tuple[str, str, int, Dict[str, Any]]:
        selected_model, tier = self._resolve_model(model, model_tier)
        is_pro = tier == "pro"
        timeout = (
            settings.DEEPSEEK_PRO_TIMEOUT_SECONDS
            if is_pro
            else settings.DEEPSEEK_FLASH_TIMEOUT_SECONDS
        )
        kwargs: Dict[str, Any] = {
            "model": selected_model,
            "messages": messages,
            "max_tokens": self._effective_max_tokens(selected_model, max_tokens),
            "stream": stream,
            "timeout": timeout,
            "extra_body": {
                "thinking": {"type": "enabled" if is_pro else "disabled"}
            },
        }
        if is_pro:
            kwargs["reasoning_effort"] = "high"
        else:
            kwargs["temperature"] = temperature
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        return selected_model, tier, timeout, kwargs

    @staticmethod
    def _usage_value(response, field: str) -> int:
        usage = getattr(response, "usage", None)
        return int(getattr(usage, field, 0) or 0)

    @classmethod
    def _log_completion(
        cls,
        *,
        model: str,
        tier: str,
        elapsed: float,
        response=None,
        finish_reason: Optional[str] = None,
        output_chars: int = 0,
    ) -> None:
        """仅记录运行元数据，不记录提示词、报告或凭证。"""
        logger.info(
            "DeepSeek调用完成: service=research_topic model=%s tier=%s "
            "thinking=%s latency_seconds=%.3f input_tokens=%s "
            "output_tokens=%s output_chars=%s finish_reason=%s",
            model,
            tier,
            "enabled" if tier == "pro" else "disabled",
            elapsed,
            cls._usage_value(response, "prompt_tokens") if response else 0,
            cls._usage_value(response, "completion_tokens") if response else 0,
            output_chars,
            finish_reason,
        )

    async def complete(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        json_mode: bool = False,
        model_tier: str = "pro",
    ) -> str:
        """使用统一医学系统提示词调用 DeepSeek。"""
        if not self.client:
            return self._get_mock_response(prompt, json_mode)
        return await self.complete_messages(
            [
                {
                    "role": "system",
                    "content": "你是一个专业的医学信息学专家，擅长深度分析医学文献和研究趋势。请提供详细、专业、有洞察力的分析。",
                },
                {"role": "user", "content": prompt},
            ],
            model=model,
            model_tier=model_tier,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=json_mode,
        )

    @retry(
        stop=stop_after_attempt(max(1, settings.LLM_MAX_RETRIES)),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=True,
    )
    async def complete_messages(
        self,
        messages: List[Dict[str, str]],
        *,
        model: Optional[str] = None,
        model_tier: str = "pro",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        json_mode: bool = False,
    ) -> str:
        """调用 DeepSeek Chat Completions，并对 Pro 截断响应扩容重试。"""
        if not self.client:
            prompt = messages[-1].get("content", "") if messages else ""
            return self._get_mock_response(prompt, json_mode)

        temperature = self.temperature if temperature is None else temperature
        answer_tokens = max_tokens or self.max_tokens
        selected_model, tier, timeout, kwargs = self._request_kwargs(
            messages=messages,
            model=model,
            model_tier=model_tier,
            temperature=temperature,
            max_tokens=answer_tokens,
            json_mode=json_mode,
            stream=False,
        )
        budgets = [kwargs["max_tokens"]]
        if tier == "pro":
            expanded = min(
                settings.DEEPSEEK_MAX_OUTPUT_TOKENS,
                kwargs["max_tokens"] * 2,
            )
            if expanded > kwargs["max_tokens"]:
                budgets.append(expanded)

        started = time.perf_counter()
        last_issue = ""
        for budget in budgets:
            kwargs["max_tokens"] = budget
            async with self._request_semaphore:
                response = await self._create_completion_with_refresh(kwargs, timeout)
            choice = response.choices[0]
            content = choice.message.content or ""
            finish_reason = getattr(choice, "finish_reason", None)
            if finish_reason == "length":
                last_issue = (
                    "DeepSeek响应被截断 "
                    f"(model={selected_model}, max_tokens={budget})"
                )
                continue
            if not content.strip():
                last_issue = f"DeepSeek返回空内容 (model={selected_model})"
                continue
            self._log_completion(
                model=selected_model,
                tier=tier,
                elapsed=time.perf_counter() - started,
                response=response,
                finish_reason=finish_reason,
                output_chars=len(content),
            )
            return content
        raise RuntimeError(last_issue)

    async def stream_messages(
        self,
        messages: List[Dict[str, str]],
        *,
        model: Optional[str] = None,
        model_tier: str = "pro",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        json_mode: bool = False,
    ) -> AsyncGenerator[str, None]:
        """流式调用 DeepSeek，只向调用方转发最终答案内容。"""
        if not self.client:
            prompt = messages[-1].get("content", "") if messages else ""
            mock = self._get_mock_response(prompt, json_mode)
            for i in range(0, len(mock), 4):
                yield mock[i:i + 4]
            return

        temperature = self.temperature if temperature is None else temperature
        answer_tokens = max_tokens or self.max_tokens
        selected_model, tier, timeout, kwargs = self._request_kwargs(
            messages=messages,
            model=model,
            model_tier=model_tier,
            temperature=temperature,
            max_tokens=answer_tokens,
            json_mode=json_mode,
            stream=True,
        )
        started = time.perf_counter()
        output_chars = 0
        finish_reason = None
        async with self._request_semaphore:
            stream = await self._create_completion_with_refresh(kwargs, timeout)
            async for chunk in stream:
                if time.perf_counter() - started > timeout:
                    raise asyncio.TimeoutError(
                        f"DeepSeek流式响应超时 (model={selected_model}, timeout={timeout}s)"
                    )
                if chunk.choices:
                    choice = chunk.choices[0]
                    finish_reason = getattr(choice, "finish_reason", None) or finish_reason
                    delta = getattr(choice.delta, "content", None) or ""
                    if delta:
                        output_chars += len(delta)
                        yield delta
        if finish_reason == "length":
            raise RuntimeError(
                f"DeepSeek流式响应被截断 (model={selected_model})"
            )
        if output_chars == 0:
            raise RuntimeError(f"DeepSeek流式响应为空 (model={selected_model})")
        self._log_completion(
            model=selected_model,
            tier=tier,
            elapsed=time.perf_counter() - started,
            finish_reason=finish_reason,
            output_chars=output_chars,
        )

    async def complete_streaming_extract(
        self,
        prompt: str,
        field_callback,
        extract_field: str = "deep_analysis",
        model: Optional[str] = None,
        model_tier: str = "pro",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> str:
        """
        流式调用 LLM（json_mode），从 JSON 流中实时提取指定字段值并通过 callback 转发。
        返回完整原始文本供 safe_parse_json 解析。

        field_callback: async callable(delta: str)，接收字段文本 token
        extract_field:  要提取的 JSON 字段名，默认 "deep_analysis"
        """
        if not self.client:
            mock = self._get_mock_response(prompt, True)
            mock_parsed = safe_parse_json(mock)
            text = mock_parsed.get(extract_field, mock)
            for i in range(0, len(text), 4):
                await field_callback(text[i:i + 4])
                await asyncio.sleep(0.01)
            return mock

        extractor = _JsonFieldExtractor(extract_field, field_callback)
        messages = [
            {
                "role": "system",
                "content": "你是一个专业的医学信息学专家，擅长深度分析医学文献和研究趋势。请提供详细、专业、有洞察力的分析。",
            },
            {"role": "user", "content": prompt},
        ]
        async for delta in self.stream_messages(
            messages,
            model=model,
            model_tier=model_tier,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=True,
        ):
            await extractor.feed(delta)
        return extractor.full_text

    async def complete_streaming(
        self,
        prompt: str,
        token_callback,
        model: Optional[str] = None,
        model_tier: str = "pro",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        json_mode: bool = False,
    ) -> str:
        """流式调用 LLM，边生成边调用 token_callback(token: str)，最终返回完整文本。
        json_mode 时仍等 JSON 完整才可解析，但 callback 可用于实时预览非结构化段落。
        """
        if not self.client:
            mock = self._get_mock_response(prompt, json_mode)
            for i in range(0, len(mock), 4):
                chunk = mock[i:i+4]
                await token_callback(chunk)
            return mock

        messages = [
            {
                "role": "system",
                "content": "你是一个专业的医学信息学专家，擅长深度分析医学文献和研究趋势。请提供详细、专业、有洞察力的分析。",
            },
            {"role": "user", "content": prompt},
        ]
        full_text = ""
        async for delta in self.stream_messages(
            messages,
            model=model,
            model_tier=model_tier,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=json_mode,
        ):
            full_text += delta
            await token_callback(delta)
        return full_text

    async def complete_stream(
        self,
        prompt: str,
        model: Optional[str] = None,
        model_tier: str = "pro",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> AsyncGenerator[str, None]:
        """流式调用LLM - 逐token yield，用于打字机效果"""
        if not self.client:
            # Mock模式：分块模拟流式
            mock = self._get_mock_response(prompt, False)
            for i in range(0, len(mock), 4):
                yield mock[i:i+4]
            return

        messages = [
            {
                "role": "system",
                "content": "你是一个专业的医学信息学专家，擅长深度分析医学文献和研究趋势。请提供详细、专业、有洞察力的分析。",
            },
            {"role": "user", "content": prompt},
        ]
        async for delta in self.stream_messages(
            messages,
            model=model,
            model_tier=model_tier,
            temperature=temperature,
            max_tokens=max_tokens,
        ):
            yield delta

    # ==================== V5.0: 三步走查询生成流程 ====================

    async def analyze_query_structure(
        self,
        preprocessed_input: Any
    ) -> Dict[str, Any]:
        """
        第一步：深度查询理解与实体化 (Query Understanding & Entitization)
        将用户输入转化为结构化的PICO实体和逻辑关系
        """
        prompt = self._build_query_understanding_prompt(preprocessed_input)

        try:
            response = await self.complete(
                prompt,
                json_mode=True,
                max_tokens=2000,
                temperature=0.1,
                model_tier="flash",
            )
            parsed = safe_parse_json(response, self._get_default_query_structure(preprocessed_input))
            return self._validate_query_structure(parsed)
        except Exception as e:
            logger.warning(f"查询理解失败，使用默认结构: {e}")
            if self.client:
                raise RuntimeError("查询理解模型不可用，停止生成以避免宽泛检索和空壳报告") from e
            return self._get_default_query_structure(preprocessed_input)

    def _build_query_understanding_prompt(self, input_obj: Any) -> str:
        """构建查询理解Prompt - V5.0 动态领域适配"""
        return f"""你是一位资深的医学信息学专家，同时精通 PubMed 检索策略设计。请深度分析以下用户输入，提取所有相关实体和概念，并直接生成用于 PubMed 检索的子查询。

## 用户输入
{input_obj.cleaned}

## 分析要求
1. **识别核心实体**：提取所有与PICO（人群、干预/暴露/机制、对照、结局）相关的核心概念
2. **实体归一化**：将口语化、非标准的术语归一到标准英文医学术语（MeSH优先）
3. **同义词扩展**：为每个核心实体提供2-4个英文同义词/近义词（包括缩写、MeSH术语、常用别名），**同义词只放入synonyms字段，不得写入pico_entities**
4. **构建实体关系**：识别实体之间的逻辑关系
5. **生成3–5条PubMed子查询**：可变化字段和同义词，但每条都必须保留用户明确给出的所有核心概念

**【严格约束】pico_entities 只能包含用户明确提供的概念的标准英文术语，不得引入用户未提及的概念、相关技术、上位概念或联想扩展词。**

## 输出格式（JSON）
{{
  "pico_entities": {{
    "population": ["标准英文术语1", "标准英文术语2"],
    "intervention": ["标准英文术语1", "标准英文术语2"],
    "comparison": ["标准英文术语1"],
    "outcome": ["标准英文术语1", "标准英文术语2"]
  }},
  "synonyms": {{
    "术语1": ["同义词a", "同义词b", "MeSH术语"],
    "术语2": ["同义词c", "缩写"]
  }},
  "logical_structure": "(population AND intervention) AND outcome",
  "research_stage_intent": "exploration|gap_hunting|idea_validation|feasibility_check|design_help|publication_strategy",
  "study_design_hint": "rct|cohort|meta|mechanism|unknown",
  "confidence": 0.0,
  "detected_domain": "该研究所属的医学领域，如肿瘤学、心血管、肾脏病学等",
  "sub_queries": [
    "子查询1：最精准，包含所有核心概念（主题词 AND 干预/机制/暴露 AND 结局），使用[Title/Abstract]字段",
    "子查询2：核心查询，包含主要2个概念 AND 组合，含同义词OR扩展，使用[Title/Abstract]字段",
    "子查询3：MeSH标准术语版本，使用[MeSH Terms]字段，覆盖标准化主题词",
    "子查询4：保留所有核心概念，替换为常用缩写或同义词",
    "子查询5：保留所有核心概念，仅放宽字段限定，不得删除人群、干预/暴露或其他显式概念"
  ]
}}

## sub_queries 生成规则
- 每条子查询必须是有效的 PubMed 布尔检索式（使用 AND/OR/NOT）
- 字段标记：普通词用 [Title/Abstract]，标准化MeSH主题词用 [MeSH Terms]
- 同一概念的多个同义词之间用 OR 连接，不同概念之间用 AND 连接
- 每条子查询的括号要闭合完整
- 示例格式：((diabetes mellitus[Title/Abstract] OR type 2 diabetes[Title/Abstract]) AND (gut microbiota[Title/Abstract] OR intestinal flora[Title/Abstract]))

**重要：根据用户实际提供的PICO要素数量调整子查询策略**
- 若用户只提供了1个要素（如只有P）：5条子查询全部围绕该要素展开，分别使用：①精准MeSH主题词 ②Title/Abstract自由词+同义词 ③相关上位概念宽泛检索 ④相关下位/细分概念检索 ⑤该要素的英文缩写/别名检索。**绝对不得在查询中引入用户未提供的I/C/O要素**
- 若用户提供了2个或更多要素：每条子查询均必须用AND保留所有显式要素；只允许改变同义词、MeSH/自由词字段或研究设计限定，不得生成单概念宽泛查询

注意：
- logical_structure使用标准布尔逻辑符号：AND, OR, NOT
- 实体应该使用标准的英文医学术语
- synonyms中为每个关键实体提供同义词，用于后续PubMed检索扩展
- 如果某类实体不存在，使用空列表
- detected_domain用于后续分析的领域适配"""

    def _validate_query_structure(self, parsed: Dict) -> Dict:
        """验证查询结构输出"""
        required_fields = ['pico_entities', 'logical_structure']

        for field in required_fields:
            if field not in parsed:
                parsed[field] = {} if field == 'pico_entities' else ""

        # 确保pico_entities包含所有字段
        pico = parsed.get('pico_entities', {})
        for key in ['population', 'intervention', 'comparison', 'outcome']:
            if key not in pico:
                pico[key] = []
        parsed['pico_entities'] = pico

        # 验证logical_structure
        if not parsed.get('logical_structure'):
            # 构建默认逻辑结构
            entities = []
            if pico.get('population'):
                entities.append(f"({' OR '.join(pico['population'][:2])})")
            if pico.get('intervention'):
                entities.append(f"({' OR '.join(pico['intervention'][:2])})")
            if pico.get('outcome'):
                entities.append(f"({' OR '.join(pico['outcome'][:2])})")
            parsed['logical_structure'] = " AND ".join(entities) if entities else ""

        # 验证并过滤 LLM 生成的 sub_queries（去除空值、过短的无效查询）
        raw_sub_queries = parsed.get('sub_queries', [])
        valid_sub_queries = [
            q.strip() for q in raw_sub_queries
            if isinstance(q, str) and len(q.strip()) > 10
        ]
        parsed['sub_queries'] = valid_sub_queries

        return parsed

    def _get_default_query_structure(self, input_obj: Any) -> Dict:
        """获取默认查询结构"""
        return {
            "pico_entities": {
                "population": [],
                "intervention": [],
                "comparison": [],
                "outcome": []
            },
            "logical_structure": input_obj.cleaned,
            "research_stage_intent": "exploration",
            "study_design_hint": "unknown",
            "confidence": 0.3
        }

    def expand_with_synonyms(self, entity: str, llm_synonyms: Dict[str, List[str]] = None) -> List[str]:
        """
        第二步：同义词扩展 (Synonym Expansion)

        优先使用LLM在查询理解阶段返回的同义词，
        其次使用内部同义词词典，最后返回原词。
        """
        entity_lower = entity.lower().strip()

        # 优先：使用LLM提供的同义词
        if llm_synonyms:
            for key, synonyms in llm_synonyms.items():
                if entity_lower == key.lower() or entity_lower in [s.lower() for s in synonyms]:
                    return list(set([entity] + synonyms))

        # 其次：内部词典直接匹配
        for canonical, synonyms in self.MEDICAL_SYNONYMS.items():
            if entity_lower in [s.lower() for s in synonyms] or entity_lower == canonical.lower():
                return synonyms

        # 部分匹配
        for canonical, synonyms in self.MEDICAL_SYNONYMS.items():
            if entity_lower in canonical.lower() or canonical.lower() in entity_lower:
                return synonyms

        # 返回原词
        return [entity]

    def build_final_queries(
        self,
        pico_entities: Dict[str, List[str]],
        logical_structure: str,
        llm_synonyms: Dict[str, List[str]] = None
    ) -> List[str]:
        """
        第三步：子查询生成与最终检索式构建 (Sub-Query Generation)
        根据实际提供的PICO要素数量自适应生成子查询，避免引入用户未提供的要素
        """
        sub_queries = []

        # 扩展所有实体的同义词
        expanded_entities = {}
        for category, entities in pico_entities.items():
            expanded_entities[category] = []
            for entity in entities:
                synonyms = self.expand_with_synonyms(entity, llm_synonyms)
                expanded_entities[category].extend(synonyms)
            expanded_entities[category] = list(set(expanded_entities[category]))

        p_terms = expanded_entities.get('population', [])
        i_terms = expanded_entities.get('intervention', [])
        o_terms = expanded_entities.get('outcome', [])

        active_elements = sum([bool(p_terms), bool(i_terms), bool(o_terms)])

        if active_elements >= 3:
            # 精准查询 P AND I AND O
            p_q = " OR ".join([f"{t}[Title/Abstract]" for t in p_terms[:3]])
            i_q = " OR ".join([f"{t}[Title/Abstract]" for t in i_terms[:3]])
            o_q = " OR ".join([f"{t}[Title/Abstract]" for t in o_terms[:2]])
            sub_queries.append(f"(({p_q}) AND ({i_q}) AND ({o_q}))")
            # 核心查询 P AND I
            sub_queries.append(f"(({p_q}) AND ({i_q}))")
            # MeSH版
            p_mesh = " OR ".join([f"{t}[MeSH Terms]" for t in p_terms[:2]])
            i_mesh = " OR ".join([f"{t}[MeSH Terms]" for t in i_terms[:2]])
            if p_mesh and i_mesh:
                sub_queries.append(f"(({p_mesh}) AND ({i_mesh}))")
            # 宽泛P
            sub_queries.append(f"({' OR '.join([f'{t}[Title/Abstract]' for t in p_terms[:3]])})")
            # 宽泛I
            sub_queries.append(f"({' OR '.join([f'{t}[Title/Abstract]' for t in i_terms[:3]])})")

        elif active_elements == 2:
            pairs = [(v) for v in [p_terms, i_terms, o_terms] if v]
            a_terms, b_terms = pairs[0], pairs[1]
            a_q = " OR ".join([f"{t}[Title/Abstract]" for t in a_terms[:3]])
            b_q = " OR ".join([f"{t}[Title/Abstract]" for t in b_terms[:3]])
            sub_queries.append(f"(({a_q}) AND ({b_q}))")
            a_mesh = " OR ".join([f"{t}[MeSH Terms]" for t in a_terms[:2]])
            b_mesh = " OR ".join([f"{t}[MeSH Terms]" for t in b_terms[:2]])
            if a_mesh and b_mesh:
                sub_queries.append(f"(({a_mesh}) AND ({b_mesh}))")
            sub_queries.append(f"({a_q})")
            sub_queries.append(f"({b_q})")
            a_mesh_broad = " OR ".join([f"{t}[MeSH Terms]" for t in a_terms[:3]])
            if a_mesh_broad:
                sub_queries.append(f"({a_mesh_broad})")

        else:
            # 只有单个要素：围绕该要素生成多种变体，绝不引入未提供的要素
            sole_terms = p_terms or i_terms or o_terms
            if sole_terms:
                # Title/Abstract 精准
                sub_queries.append(f"({' OR '.join([f'{t}[Title/Abstract]' for t in sole_terms[:4]])})")
                # MeSH主题词
                mesh_q = " OR ".join([f"{t}[MeSH Terms]" for t in sole_terms[:3]])
                if mesh_q:
                    sub_queries.append(f"({mesh_q})")
                # 宽泛同义词扩展（更多词）
                if len(sole_terms) > 2:
                    sub_queries.append(f"({' OR '.join([f'{t}[Title/Abstract]' for t in sole_terms])})")
                # All Fields 版本（覆盖更广）
                sub_queries.append(f"({' OR '.join([f'{t}[All Fields]' for t in sole_terms[:3]])})")
            elif logical_structure:
                sub_queries.append(logical_structure)

        if not sub_queries and logical_structure:
            sub_queries.append(logical_structure)

        return sub_queries

    # ==================== 向后兼容的旧方法 ====================

    async def standardize_input(
        self,
        preprocessed_input: Any
    ) -> Dict[str, Any]:
        """输入标准化 - V5.0集成三步走流程"""
        # 第一步：查询理解与实体化
        query_structure = await self.analyze_query_structure(preprocessed_input)

        # 第三步：生成子查询
        sub_queries = self.build_final_queries(
            query_structure.get('pico_entities', {}),
            query_structure.get('logical_structure', '')
        )
        query_structure['sub_queries'] = sub_queries

        # 构建标准化输入
        return self._build_standardized_output(preprocessed_input, query_structure)

    def _build_standardized_output(
        self,
        input_obj: Any,
        query_structure: Dict
    ) -> Dict:
        """构建标准化输出"""
        pico = query_structure.get('pico_entities', {})

        # 构建query_terms
        all_terms = []
        for terms in pico.values():
            all_terms.extend(terms)

        return {
            "core_entities": {
                "drugs": pico.get('intervention', []),
                "diseases": pico.get('population', []),
                "genes": [],
                "mechanisms": [],
                "outcomes": pico.get('outcome', []),
                "populations": pico.get('population', []),
                "interventions": pico.get('intervention', []),
                "comparators": pico.get('comparison', [])
            },
            "study_design_hint": query_structure.get('study_design_hint', 'unknown'),
            "research_stage_intent": query_structure.get('research_stage_intent', 'exploration'),
            "question_structure": "association_question",
            "research_axis": "treatment",
            "query_terms": {
                "zh": [],
                "en": all_terms[:8]
            },
            "pico_elements": {
                "population": ", ".join(pico.get('population', [])) if pico.get('population') else None,
                "intervention": ", ".join(pico.get('intervention', [])) if pico.get('intervention') else None,
                "comparison": ", ".join(pico.get('comparison', [])) if pico.get('comparison') else None,
                "outcome": ", ".join(pico.get('outcome', [])) if pico.get('outcome') else None
            },
            "pico_entities": pico,
            "logical_structure": query_structure.get('logical_structure', ''),
            "sub_queries": query_structure.get('sub_queries', []),
            "confidence": query_structure.get('confidence', 0.7),
            "research_context": ""
        }

    def _get_mock_response(self, prompt: str, json_mode: bool = False) -> str:
        """获取模拟响应"""
        if json_mode:
            return json.dumps({
                "pico_entities": {
                    "population": ["membranous nephropathy"],
                    "intervention": ["rituximab"],
                    "comparison": [],
                    "outcome": ["remission", "relapse"]
                },
                "logical_structure": "(membranous nephropathy) AND (rituximab)",
                "study_design_hint": "rct",
                "research_stage_intent": "exploration",
                "confidence": 0.7
            }, ensure_ascii=False)
        return "模拟响应（LLM未配置）"

    async def expand_queries(self, query_terms: Dict[str, List[str]]) -> Dict[str, List[str]]:
        """
        查询词扩展 - V5.0使用同义词词典
        """
        expanded = {"zh": [], "en": []}

        for lang in ['zh', 'en']:
            terms = query_terms.get(lang, [])
            expanded_terms = set()
            for term in terms:
                synonyms = self.expand_with_synonyms(term)
                expanded_terms.update(synonyms)
            expanded[lang] = list(expanded_terms)

        return expanded

    async def generate_deep_analysis(
        self,
        section_name: str,
        data: Dict[str, Any],
        query_context: str
    ) -> str:
        """生成深度分析内容"""
        prompts = {
            "background_summary": f"""你是一位资深的医学文献综述专家。请基于以下数据，撰写一段深入的背景分析（400-600字）。

研究主题: {query_context}
数据: {json.dumps(data, ensure_ascii=False, indent=2)}

要求:
1. 分析该领域的研究发展脉络和关键转折点
2. 指出现有研究的主要局限性和争议点
3. 说明该研究领域的临床意义和应用价值
4. 语言专业、逻辑清晰、有学术深度""",

            "evidence_interpretation": f"""你是一位循证医学专家。请深入分析以下证据结构数据（300-500字）。

研究主题: {query_context}
证据数据: {json.dumps(data, ensure_ascii=False, indent=2)}

要求:
1. 分析证据金字塔的结构性问题
2. 指出基础研究向临床转化存在的断层
3. 评估当前证据的可靠性和局限性
4. 提出证据质量提升的建议""",

            "gap_analysis": f"""你是一位医学研究战略专家。请深入分析以下研究空白（400-600字）。

研究主题: {query_context}
研究空白: {json.dumps(data, ensure_ascii=False, indent=2)}

要求:
1. 分析每个研究空白的临床重要性和紧迫性
2. 评估填补该空白的可行性和技术难度
3. 提出具体的研究设计建议
4. 预测研究成果的潜在影响力""",

            "journal_recommendation": f"""你是一位医学期刊投稿专家。请基于以下信息，撰写期刊推荐理由（150-200字）。

研究主题: {query_context}
期刊信息: {json.dumps(data, ensure_ascii=False, indent=2)}

要求:
1. 分析期刊的研究方向和偏好
2. 说明该研究主题与期刊的匹配度
3. 提供投稿策略建议""",

            "topic_generation": f"""你是一位资深的临床研究设计师。请基于研究空白，设计2-3个高质量的研究选题。

研究主题: {query_context}
研究空白: {json.dumps(data, ensure_ascii=False, indent=2)}

要求每个选题包含:
1. 创新性研究标题
2. 完整的PICO结构
3. 建议的研究类型
4. 创新性评分及理由
5. 可行性分析"""
        }

        prompt = prompts.get(section_name, prompts["background_summary"])

        try:
            return await self.complete(prompt, max_tokens=1500, temperature=0.3)
        except Exception as e:
            return f"[{section_name}生成失败: {str(e)}]"


# 全局LLM服务实例
llm_service = LLMService()

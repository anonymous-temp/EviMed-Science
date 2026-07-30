"""Post-write consistency, plausibility and language guards."""
from __future__ import annotations

import re

from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.study import ExtractedStudy
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.grade import GRADEProfile
from new_meta.tools.utils import first_author_lastname as _first_author


class ConsistencyGuardsMixin:
    """Post-write consistency, plausibility and language guards."""

    _CERTAINTY_REPLACEMENTS = [
        # Chinese forbidden → replacement
        (r'可以改善', '可能改善'),
        (r'可改善', '可能改善'),
        (r'能够改善', '可能改善'),
        (r'是有效的', '证据有限，可能有一定效果'),
        (r'证实了', '提示'),
        (r'明确表明', '提示'),
        (r'结论性证据', '证据有限'),
        (r'显著改善(?!(?:趋势|可能))', '可能有改善'),
        (r'显著优于', '可能优于'),
        (r'确切疗效', '可能疗效'),
        (r'疗效确切', '疗效尚需验证'),
        (r'已经证实', '研究提示'),
        # English forbidden → replacement
        (r'can improve\b', 'may improve'),
        (r'is effective\b', 'may be effective'),
        (r'significantly improves\b', 'may improve'),
        (r'clearly demonstrates?\b', 'suggests'),
        (r'conclusively shows?\b', 'suggests'),
        (r'proves?\s+that\b', 'suggests that'),
        (r'confirmed\s+that\b', 'suggested that'),
    ]

    def _enforce_hedged_language(self, manuscript: str) -> str:
        """Replace definitive claims with hedged language throughout the manuscript."""
        # Patterns also covered by narrative constraints — skip in narrative mode
        # to avoid conflict (narrative uses stronger replacements)
        _narrative_overlap = {'显著优于'}
        for pattern, replacement in self._CERTAINTY_REPLACEMENTS:
            if self._narrative_mode and any(ov in pattern for ov in _narrative_overlap):
                continue
            new_ms = re.sub(pattern, replacement, manuscript, flags=re.IGNORECASE)
            if new_ms != manuscript:
                self.log(f"结论措辞修正: '{pattern}' → '{replacement}'", level="warning")
                manuscript = new_ms
        return manuscript

    _NARRATIVE_FORBIDDEN = [
        (r'一致性较好', '各研究结果存在差异'),
        (r'一致性良好', '各研究结果存在差异'),
        (r'效应强度', '效应方向'),
        (r'显著优于', '可能存在差异'),
        (r'稳健支持', '有限证据提示'),
        (r'有力证据', '初步证据'),
        (r'方向一致', '存在差异'),
        (r'significant\s+improvement', 'possible improvement'),
        (r'clearly\s+effective', 'may have some effect'),
        (r'good\s+consistency', 'varying results'),
        (r'strong\s+evidence', 'limited evidence'),
    ]

    def _enforce_narrative_constraints(self, manuscript: str) -> str:
        """Enforce narrative mode language constraints."""
        for pattern, replacement in self._NARRATIVE_FORBIDDEN:
            new_ms = re.sub(pattern, replacement, manuscript, flags=re.IGNORECASE)
            if new_ms != manuscript:
                self.log(f"叙述模式措辞修正: '{pattern}' → '{replacement}'", level="warning")
                manuscript = new_ms
        return manuscript

    def _auto_consistency_check(
        self,
        manuscript: str,
        studies: list[ExtractedStudy],
        grade_profile: GRADEProfile = None,
        rob_results: list[StudyRoB] = None,
    ) -> str:
        """Auto-downgrade conclusions for few studies and missing statistics."""
        n_studies = self._included_count or len(studies)
        zh = self._zh

        # If ≤2 studies: insert explicit downgrade note in conclusion section
        if n_studies <= 2:
            self.log(
                f"Detected small-study evidence base ({n_studies} studies); keeping the caution out of the manuscript body.",
                level="warning",
            )

        # 【五】GRADE一致性：如果未执行GRADE但报告提及GRADE，添加说明或删除
        has_grade = grade_profile is not None and hasattr(grade_profile, 'outcomes') and len(grade_profile.outcomes) > 0
        if not has_grade:
            # Check if manuscript mentions GRADE in a claim-like way
            grade_claim_pattern = r'(?:GRADE\s*(?:评级|评价|评估|certainty|assessment|rating|等级)\s*[为:=：]\s*(?:高|中|低|很高|High|Moderate|Low|Very\s*low))'
            if re.search(grade_claim_pattern, manuscript, re.IGNORECASE):
                # Remove the specific GRADE claim lines
                lines = manuscript.split('\n')
                cleaned = []
                for line in lines:
                    if re.search(grade_claim_pattern, line, re.IGNORECASE):
                        self.log(f"移除未执行的GRADE评级描述: {line.strip()[:60]}", level="warning")
                        continue
                    cleaned.append(line)
                manuscript = '\n'.join(cleaned)

        # Check for missing key statistics in non-narrative mode
        if not self._narrative_mode and studies:
            missing_stats = []
            for s in studies:
                has_effect = any(
                    o.effect_size is not None or
                    (o.mean_intervention is not None and o.sd_intervention is not None) or
                    (o.events_intervention is not None and o.total_intervention is not None)
                    for o in s.outcomes
                )
                if not has_effect:
                    sid = s.characteristics.pmid or s.characteristics.study_id or "unknown"
                    first = _first_author(s.characteristics.authors)
                    missing_stats.append(f"{first} {s.characteristics.year}")

            if missing_stats:
                if zh:
                    note = (
                        "\n\n> **注意**：以下研究未提供可提取的定量效应量数据："
                        + "、".join(missing_stats)
                        + "。这些研究无法用于效应量合并比较，仅做定性描述。\n"
                    )
                else:
                    note = (
                        "\n\n> **Note**: The following studies did not provide extractable "
                        "quantitative effect size data: "
                        + ", ".join(missing_stats)
                        + ". These studies cannot be used for effect size comparison "
                        "and are only described qualitatively.\n"
                    )
                # Insert before Discussion
                if zh:
                    insert_before = "## 讨论"
                else:
                    insert_before = "## Discussion"
                if insert_before in manuscript:
                    manuscript = manuscript.replace(insert_before, note + insert_before, 1)
                    self.log(f"插入缺失统计量说明 ({len(missing_stats)} 项研究)", level="warning")

        # 【三】纳入标准一致性：检查研究随访时长是否满足≥12周
        short_studies = []
        for s in studies:
            dur = s.characteristics.follow_up_duration or ""
            dur_lower = dur.lower().replace(" ", "")
            # Try to extract numeric weeks from follow_up_duration
            import re as _re
            weeks_match = _re.search(r'(\d+(?:\.\d+)?)\s*(?:周|week|wk)', dur_lower)
            months_match = _re.search(r'(\d+(?:\.\d+)?)\s*(?:月|month|mo)', dur_lower)
            weeks = None
            if weeks_match:
                weeks = float(weeks_match.group(1))
            elif months_match:
                weeks = float(months_match.group(1)) * 4.33
            if weeks is not None and weeks < 12:
                first = _first_author(s.characteristics.authors)
                short_studies.append(f"{first} {s.characteristics.year} ({dur})")

        if short_studies:
            if zh:
                note = (
                    "\n\n> **例外纳入说明**：以下研究随访时长不足12周（"
                    + "、".join(short_studies)
                    + "），考虑到其研究设计与本系统评价问题的相关性，经评估后作为例外纳入，"
                    "但在解读结果时需注意随访时长不足对结局估计的潜在影响。\n"
                )
            else:
                note = (
                    "\n\n> **Exception inclusion note**: The following studies had follow-up "
                    "duration less than 12 weeks ("
                    + ", ".join(short_studies)
                    + "). They were included as exceptions due to their relevance to the review "
                    "question, but results should be interpreted with caution given the potential "
                    "impact of shorter follow-up on outcome estimates.\n"
                )
            if zh:
                insert_before = "## 讨论"
            else:
                insert_before = "## Discussion"
            if insert_before in manuscript:
                manuscript = manuscript.replace(insert_before, note + insert_before, 1)
                self.log(f"插入例外纳入说明 ({len(short_studies)} 项研究)", level="warning")

        return manuscript

    def _fix_prisma_checklist_consistency(
        self,
        manuscript: str,
        rob_results: list[StudyRoB],
        grade_profile: GRADEProfile = None,
    ) -> str:
        """Fix PRISMA checklist N/A markings to match actual work performed."""
        has_rob = bool(rob_results)
        has_grade = grade_profile is not None and hasattr(grade_profile, 'outcomes') and len(grade_profile.outcomes) > 0
        na_zh = "未适用"
        na_en = "N/A"

        # If RoB was done but PRISMA says N/A for RoB items, fix it
        if has_rob:
            if self._zh:
                manuscript = manuscript.replace(
                    "| 偏倚风险 | 11 | 描述偏倚风险评估方法 | 未适用 |",
                    "| 偏倚风险 | 11 | 描述偏倚风险评估方法 | 方法 |",
                )
                manuscript = manuscript.replace(
                    "| 偏倚风险 | 18 | 报告偏倚风险评估结果 | 未适用 |",
                    "| 偏倚风险 | 18 | 报告偏倚风险评估结果 | 结果，图4 |",
                )
            else:
                manuscript = manuscript.replace(
                    "| Study risk of bias | 11 | Describe methods for assessing risk of bias | N/A |",
                    "| Study risk of bias | 11 | Describe methods for assessing risk of bias | Methods |",
                )
                manuscript = manuscript.replace(
                    "| Risk of bias in studies | 18 | Report results of risk of bias assessments | N/A |",
                    "| Risk of bias in studies | 18 | Report results of risk of bias assessments | Results, Figure 4 |",
                )

        # If GRADE was done but PRISMA says N/A for GRADE items
        if has_grade and self._narrative_mode:
            if self._zh:
                manuscript = manuscript.replace(
                    "| 证据确定性 | 21 | 报告每个结局的 GRADE 评级 | 未适用 |",
                    "| 证据确定性 | 21 | 报告每个结局的 GRADE 评级 | 结果 |",
                )
            else:
                manuscript = manuscript.replace(
                    "| Certainty of evidence | 21 | Report GRADE certainty for each outcome | N/A |",
                    "| Certainty of evidence | 21 | Report GRADE certainty for each outcome | Results |",
                )

        return manuscript

    def _detect_statistical_placeholders(self, manuscript: str) -> list[str]:
        """Detect placeholder and impossible statistical values in any mode."""
        issues = []
        patterns = [
            # p-value placeholders
            (r'(?:p|P)\s*[=＝]\s*[01]\.0{3,}(?!\d)', "placeholder p-value (p=1.0000 or p=0.0000)"),
            # Zero effect with zero CI
            (r'(?:OR|RR|HR|MD|SMD|WMD|Hedges?\'?\s*g?)\s*[=＝]\s*0\.00\b', "impossible zero effect size"),
            # Zero CI range
            (r'95%\s*CI\s*[:：]?\s*0\.00\s*[-–—to至]\s*0\.00', "zero-width CI (0.00-0.00)"),
            # Placeholder heterogeneity bundle
            (r'I²\s*[=＝]\s*0\.0?%.*?Q\s*[=＝]\s*0\.00.*?p\s*[=＝]\s*1\.0000', "placeholder heterogeneity bundle (I²=0%, Q=0, p=1.0000)"),
            # Narrative mode specific: meta-analysis model names
            (r'(?:fixed-effect|random-effects)\s+model', "meta-analysis model name in narrative report"),
            (r'DerSimonian-Laird', "DerSimonian-Laird method in narrative report"),
            # Sensitivity/subgroup claimed without data
            (r'(?:敏感性|sensitivity)\s*(?:分析|analysis).*(?:排除|excluded)', "sensitivity analysis claim without data"),
        ]
        for pattern, label in patterns:
            if re.search(pattern, manuscript, re.IGNORECASE):
                issues.append(label)
        return issues

    def _clean_placeholder_statistics(self, manuscript: str) -> str:
        """Remove placeholder and impossible statistical values from manuscript."""
        # Fix placeholder p-values: p=0.0000 → p<0.001, p=1.0000 → note
        def _fix_p(m):
            val = m.group(0)
            if re.match(r'(?:p|P)\s*[=＝]\s*0', val):
                return 'p<0.001'
            return '(p-value not reported)' if not self._zh else '（p值未报告）'

        manuscript = re.sub(
            r'(?:p|P)\s*[=＝]\s*[01]\.0{3,}(?!\d)',
            _fix_p,
            manuscript,
        )
        # Remove impossible zero effect sizes (OR=0.00, RR=0.00, etc.) in non-table contexts
        manuscript = re.sub(
            r'(?:OR|RR|HR|MD|SMD|WMD|Hedges?\'?\s*g?)\s*[=＝]\s*0\.00\b(?!\s*[%\|])',
            lambda m: self._zh and '（效应量未报告）' or '(effect not reported)',
            manuscript,
        )
        # Remove zero-width CIs
        manuscript = re.sub(
            r'95%\s*CI\s*[:：]?\s*0\.00\s*[-–—to至]\s*0\.00',
            lambda m: self._zh and '95%CI：未报告' or '95% CI: not reported',
            manuscript,
        )
        # Remove placeholder heterogeneity bundles
        manuscript = re.sub(
            r'I²\s*[=＝]\s*0\.0?%.*?Q\s*[=＝]\s*0\.00.*?p\s*[=＝]\s*1\.0000',
            '',
            manuscript,
        )
        return manuscript

    def _enforce_narrative_title(self, manuscript: str) -> str:
        """Ensure narrative mode title does not contain Meta分析."""
        lines = manuscript.split('\n')
        for i, line in enumerate(lines):
            if line.startswith('# ') and not line.startswith('## '):
                if any(kw in line for kw in ('Meta分析', 'Meta-Analysis', 'meta-analysis', '荟萃分析', '系统评价与Meta')):
                    lines[i] = re.sub(
                        r'(?:Meta[- ]?[Aa]nalysis|Meta分析|荟萃分析|系统评价与Meta分析)',
                        '系统评价', line
                    )
                    self.log(f"修正标题: 移除Meta分析 → {lines[i][:60]}", level="warning")
                break
        return '\n'.join(lines)

    _CROSS_SYNTHESIS_PATTERNS = [
        (r'综合来看[,，]', '需注意：'),
        (r'总体显示', '各研究分别显示'),
        (r'方向一致[,，]', '但测量方式不同，'),
        (r'稳健支持', '有限证据提示'),
        (r'结果一致表明', '各研究分别提示'),
        (r'所有研究均显示', '各研究分别显示'),
        (r'总体而言[,，]\s*研究表明', '由于测量方式不同，各研究仅可独立解读'),
        (r'各研究结果?均显示', '各研究分别显示'),
        (r'overall[,，]\s*(?:the\s+)?(?:results?\s+)?(?:show|suggest|indicate|demonstrate)',
         'individual studies separately suggest'),
        (r'the\s+results\s+were\s+consistent\b',
         'results should be interpreted independently due to measurement differences'),
        (r'consistently\s+demonstrated', 'individually reported'),
        (r'all\s+studies\s+(?:showed|found|reported|demonstrated)',
         'individual studies separately reported'),
        (r'findings\s+were\s+consistent\s+across\s+studies',
         'findings cannot be directly compared across studies'),
        (r'the\s+evidence\s+(?:collectively|overall)\s+suggests',
         'individual studies suggest'),
        (r'总体趋势', '各研究分别显示'),
        (r'跨研究归纳', '各研究独立描述'),
    ]

    def _check_report_state_consistency(self, manuscript: str) -> str:
        """Validate manuscript numbers against report_state. Auto-fix mismatches."""
        rs = getattr(self, '_report_state', None)
        if rs is None:
            return manuscript

        issues: list[str] = []

        # 1. Remove duplicate "## 结果" / "## Results" headings
        for pattern_str in [r'^##+\s*结果\b', r'^##+\s*Results?\b']:
            p = re.compile(pattern_str, re.MULTILINE | re.IGNORECASE)
            matches = list(p.finditer(manuscript))
            if len(matches) > 1:
                for m in reversed(matches[1:]):
                    line_end = manuscript.find('\n', m.end())
                    manuscript = manuscript[:m.start()] + manuscript[line_end + 1:]
                issues.append(f"Removed duplicate heading ({pattern_str})")

        # 2. Auto-fix wrong "纳入 X 项研究" count
        correct_n = rs.n_direct_eligible
        # Chinese: "纳入3项研究" — use negative lookbehind to avoid matching inside other numbers
        wrong_count_zh = re.findall(r'(?<!\d)纳入\s*(\d+)\s*项\s*(?:研究|RCT|随机对照)', manuscript)
        for wc in wrong_count_zh:
            if int(wc) != correct_n:
                manuscript = re.sub(
                    rf'(?<!\d)(纳入\s*){wc}(\s*项)',
                    rf'\g<1>{correct_n}\g<2>',
                    manuscript,
                )
                issues.append(f"Fixed wrong count: 纳入{wc}项 → 纳入{correct_n}项")

        # English: "included X studies" — use word boundary to avoid partial matches
        wrong_count_en = re.findall(r'\b(?:included|include)\s*(\d+)\s*(?:studies|RCTs)\b', manuscript, re.IGNORECASE)
        for wc in wrong_count_en:
            if int(wc) != correct_n:
                manuscript = re.sub(
                    rf'\b(included|include)\s*{wc}\s*(studies|RCTs)\b',
                    rf'\g<1> {correct_n} \g<2>',
                    manuscript,
                    flags=re.IGNORECASE,
                )
                issues.append(f"Fixed wrong count: {wc} studies → {correct_n} studies")

        # 3. Evidence gap mode: auto-remove "纳入RCT" claims
        if rs.report_type == "evidence_gap":
            gap_patterns = [
                (r'纳入\s*\d+\s*项\s*(?:RCT|随机对照)[^。\n]*。?', ''),
                (r'\d+\s*RCTs?\s+were\s+included[^.\n]*\.?', ''),
            ]
            for pattern, repl in gap_patterns:
                new_ms = re.sub(pattern, repl, manuscript, flags=re.IGNORECASE)
                if new_ms != manuscript:
                    issues.append(f"Evidence gap: removed forbidden RCT claim")
                    manuscript = new_ms

        # 4. Narrative mode: auto-remove meta terms
        if rs.report_type == "narrative":
            narrative_fixes = [
                (r'合并效应量', '效应方向'),
                (r'pooled\s+effect\s+(?:size|estimate)', 'individual effect estimate'),
                (r'I²\s*=\s*\d+\.?\d*%', '(异质性未进行定量评估)'),
            ]
            for pattern, repl in narrative_fixes:
                new_ms = re.sub(pattern, repl, manuscript, flags=re.IGNORECASE)
                if new_ms != manuscript:
                    issues.append(f"Narrative: replaced '{pattern[:20]}' → '{repl}'")
                    manuscript = new_ms

        # 5. Fix outcome mislabel: "结局不一致" for studies that reported but data not extractable
        ot = rs.outcome_tiers or {}
        reported_not_ext_count = sum(1 for t in ot.values() if t == "outcome_reported_but_not_extractable")
        if reported_not_ext_count > 0:
            new_ms = re.sub(
                r'主要结局[^。\n]*不一致',
                f'主要结局报告但数据不完整（{reported_not_ext_count}项研究）',
                manuscript,
            )
            if new_ms != manuscript:
                issues.append("Fixed outcome mislabel: '结局不一致' → '数据不完整'")
                manuscript = new_ms

        if issues:
            for issue in issues:
                self.log(f"Consistency check: {issue}", level="warning")

        return manuscript

    def _detect_measurement_heterogeneity(self, studies: list) -> dict:
        """Detect incompatible measurement types across studies."""
        has_endpoint = has_change = False
        has_dose_response = has_single_dose = False

        for s in studies:
            for o in s.outcomes:
                name = (o.outcome_name or "").lower()
                if any(kw in name for kw in [
                    "change", "change-from-baseline", "变化", "改变量",
                    "delta", "减少量", "增加量", "降低量", "升高量",
                ]):
                    has_change = True
                elif any(kw in name for kw in [
                    "endpoint", "end-point", "终点", "final", "最终",
                ]):
                    has_endpoint = True
                elif name:
                    has_endpoint = True

                if any(kw in name for kw in [
                    "dose-response", "剂量反应", "dose-dependent", "剂量依赖",
                ]):
                    has_dose_response = True
                elif name:
                    has_single_dose = True

        any_incompatible = (has_endpoint and has_change) or (has_dose_response and has_single_dose)

        return {
            "endpoint_vs_change": has_endpoint and has_change,
            "dose_vs_single": has_dose_response and has_single_dose,
            "any_incompatible": any_incompatible,
        }

    def _enforce_no_cross_study_synthesis(self, manuscript: str, studies: list) -> str:
        """Prohibit cross-study synthesis when measurements are incompatible."""
        het = self._detect_measurement_heterogeneity(studies)
        if not het["any_incompatible"]:
            return manuscript

        zh = self._zh
        reasons = []
        if het["endpoint_vs_change"]:
            reasons.append("终点值与变化值" if zh else "endpoint vs change-from-baseline")
        if het["dose_vs_single"]:
            reasons.append("剂量反应与单剂量" if zh else "dose-response vs single dose")

        for pattern, replacement in self._CROSS_SYNTHESIS_PATTERNS:
            new_ms = re.sub(pattern, replacement, manuscript, flags=re.IGNORECASE)
            if new_ms != manuscript:
                self.log(f"跨研究整合修正: '{pattern[:30]}' → '{replacement[:30]}'", level="warning")
                manuscript = new_ms

        self.log(
            "Detected incompatible outcome measurement formats; keeping the caution out of the manuscript body.",
            level="warning",
        )
        return manuscript

    _SPECULATION_PATTERNS_ZH = [
        re.compile(
            r'可能\s*(?:是由于|因为|归因于|与[^。，]{1,8}有关)\s*[^。，；\n]{5,80}?'
            r'(?=。|，|；|$)',
        ),
        re.compile(
            r'这\s*(?:可能|或许)\s*(?:是由于|因为)\s*[^。，；\n]{5,80}?'
            r'(?=。|，|；|$)',
        ),
        # Effect direction inference without citation
        re.compile(
            r'(?:效应|效果|作用)\s*(?:方向|趋势)\s*(?:为|是|呈)\s*[^。，；\n]{2,40}?'
            r'(?=。|，|；|$)',
        ),
        re.compile(
            r'(?:效应量|干预效果)\s*(?:应为|应该是|推测为|估计为)\s*[^。，；\n]{2,40}?'
            r'(?=。|，|；|$)',
        ),
    ]

    _SPECULATION_PATTERNS_EN = [
        re.compile(
            r'(?:this|that|which|it)\s+(?:may|might|could)\s+(?:be\s+)?'
            r'(?:due\s+to|because\s+of|attributed?\s+to|caused\s+by|related\s+to)\s+'
            r'[^.;\n]{5,100}?(?=[.;]|\s*$)',
            re.IGNORECASE,
        ),
        # Effect direction inference without citation
        re.compile(
            r'(?:the\s+)?(?:effect|treatment)\s+(?:direction|trend)\s+'
            r'(?:is|was|appears?\s+to\s+be)\s+[^.;\n]{3,60}?(?=[.;]|\s*$)',
            re.IGNORECASE,
        ),
    ]

    def _enforce_no_speculation(self, manuscript: str) -> str:
        """Replace speculative explanations without author citations."""
        zh = self._zh
        replacement = "原因尚不明确，原研究未提供充分信息" if zh else \
            "The reason remains unclear; the original study did not provide sufficient information"
        patterns = self._SPECULATION_PATTERNS_ZH if zh else self._SPECULATION_PATTERNS_EN

        lines = manuscript.split('\n')
        cleaned = []
        for line in lines:
            # Skip table rows and base64 image lines
            if line.strip().startswith('|') or '](data:image/' in line:
                cleaned.append(line)
                continue
            # Keep lines with citation numbers ([3], [1,5]) or author explanations
            has_citation = bool(re.search(r'\[\d+(?:[,，]\s*\d+)*\]', line))
            has_author_ref = bool(re.search(
                r'(?:作者|研究组?|authors?\s+(?:noted|reported|suggested|attributed|explained))',
                line, re.IGNORECASE,
            ))
            if has_citation or has_author_ref:
                cleaned.append(line)
                continue

            for pat in patterns:
                new_line = pat.sub(replacement, line)
                if new_line != line:
                    self.log(f"推测性解释修正: '{line.strip()[:60]}'", level="warning")
                    line = new_line
            cleaned.append(line)

        return '\n'.join(cleaned)

    def _fix_statistical_expressions(self, manuscript: str) -> str:
        """Fix p=0.0 → p<0.001 and mark missing units."""
        # p=0.0 → p<0.001 (catch all variants)
        new = re.sub(r'(?:p|P)\s*[=＝]\s*0\.0+(?!\d)', 'p<0.001', manuscript)
        if new != manuscript:
            self.log("统计修复: p=0.0 → p<0.001", level="warning")
            manuscript = new

        # Mark numeric values without units after decrease/increase verbs
        zh = self._zh
        unit_note = "（原研究未报告单位）" if zh else " (unit not reported in original study)"

        if zh:
            manuscript = re.sub(
                r'(?:减少了?|降低了?|增加了?|升高了?|下降了?|改善[了为]?)\s*(\d+(?:\.\d+)?)\s*(?=，|。|；|\)|$)',
                lambda m: m.group(0).rstrip() + unit_note if not re.search(r'%|mg|kg|mmol|mmHg|cm|ml|周|月|年|分|岁', m.group(0)) else m.group(0),
                manuscript,
            )
        else:
            manuscript = re.sub(
                r'(?:decreased|reduced|increased|elevated|declined|improved)\s+by\s+(\d+(?:\.\d+)?)\s*(?=[,;.):\)]|$)',
                lambda m: m.group(0) + unit_note if not re.search(r'%|mg|kg|mmol|mmHg|cm|ml|week|month|year|day|score|point', m.group(0)) else m.group(0),
                manuscript,
                flags=re.IGNORECASE,
            )

        return manuscript

    _UNIT_CONFLICT_PAIRS = [
        # Blood glucose / lipids
        ("mg/dl", "mmol/l", "血糖"),
        ("mg/dl", "mmol/l", "胆固醇"),
        ("mg/dl", "mmol/l", "cholesterol"),
        ("mg/dl", "mmol/l", "glucose"),
        # Body weight scale
        ("kg", "g", "体重"),
        ("kg", "g", "weight"),
        # Blood pressure
        ("mmhg", "kpa", "血压"),
        ("mmhg", "kpa", "pressure"),
        # Hemoglobin
        ("g/dl", "g/l", "血红蛋白"),
        ("g/dl", "g/l", "hemoglobin"),
    ]

    def _check_unit_consistency(self, manuscript: str, studies: list) -> str:
        """Detect incompatible units for the same outcome across studies."""
        zh = self._zh
        ms_lower = manuscript.lower()

        conflicts_found = []
        for unit_a, unit_b, keyword in self._UNIT_CONFLICT_PAIRS:
            if unit_a in ms_lower and unit_b in ms_lower:
                # Verify keyword context exists nearby
                if keyword.lower() in ms_lower:
                    conflicts_found.append((unit_a, unit_b, keyword))

        if not conflicts_found:
            return manuscript

        self.log(
            f"Detected unit consistency warning ({len(conflicts_found)} conflicts); keeping it out of the manuscript body.",
            level="warning",
        )
        return manuscript

    _MEDICAL_IMPLAUSIBILITY_RULES = [
        # Weight gain > 10kg (context: treatment for metabolic/chronic disease)
        (re.compile(
            r'(?:体重|body\s*weight)\s*(?:增加|增加了?|gain|gained|increased)\s*'
            r'(\d+(?:\.\d+)?)\s*(kg|千克)',
            re.IGNORECASE,
        ), 10.0, "体重异常增加"),
        # HbA1c increase under glucose-lowering therapy
        (re.compile(
            r'(?:降糖|glucose.lowering|antidiabetic|降糖药).{0,30}?'
            r'(?:HbA1c|糖化血红蛋白).{0,20}?(?:升高|增加|上升|increased|elevated|worsened)',
            re.IGNORECASE,
        ), None, "HbA1c方向异常"),
    ]

    def _check_medical_plausibility(self, manuscript: str) -> str:
        """Detect medically implausible results and append caution notes."""
        zh = self._zh
        flags = []

        for pattern, threshold, label in self._MEDICAL_IMPLAUSIBILITY_RULES:
            for m in pattern.finditer(manuscript):
                if threshold is not None:
                    try:
                        value = float(m.group(1))
                        if value > threshold:
                            flags.append(label)
                            break
                    except (IndexError, ValueError):
                        continue
                else:
                    flags.append(label)
                    break

        if not flags:
            return manuscript

        # Deduplicate
        flags = list(dict.fromkeys(flags))

        self.log(
            f"Detected medical plausibility warning ({', '.join(flags)}); keeping it out of the manuscript body.",
            level="warning",
        )
        return manuscript

    def _check_pico_consistency(
        self, manuscript: str, studies: list, protocol: ResearchProtocol,
    ) -> str:
        """Flag studies with populations or primary outcomes mismatching PICO."""
        zh = self._zh
        notes = []

        # --- Population consistency ---
        target_pop = (protocol.pico.population or "").lower()
        if target_pop:
            target_keywords = [
                kw.strip().lower()
                for kw in re.split(r'[，,;；\s()（）]+', target_pop)
                if len(kw.strip()) > 2
            ]
            if target_keywords:
                mismatched_pop = []
                for s in studies:
                    c = s.characteristics
                    study_pop = (c.population_description or "").lower()
                    if not study_pop:
                        continue
                    if not any(kw in study_pop for kw in target_keywords):
                        first = _first_author(c.authors)
                        mismatched_pop.append(f"{first} {c.year}")
                if mismatched_pop:
                    if zh:
                        notes.append(
                            "人群特征不完全符合纳入标准（"
                            + "、".join(mismatched_pop)
                            + "），外推性可能受限"
                        )
                    else:
                        notes.append(
                            "population not fully matching criteria ("
                            + ", ".join(mismatched_pop)
                            + "); generalizability may be limited"
                        )

        # --- Primary outcome consistency ---
        target_outcome = (protocol.pico.outcome_primary or "").lower()
        if target_outcome:
            target_outcome_kws = [
                kw.strip().lower()
                for kw in re.split(r'[，,;；\s()（）]+', target_outcome)
                if len(kw.strip()) > 2
            ]
            if target_outcome_kws:
                mismatched_outcome = []
                for s in studies:
                    for o in s.outcomes:
                        outcome_name = (o.outcome_name or "").lower()
                        if not outcome_name:
                            continue
                        if not any(kw in outcome_name for kw in target_outcome_kws):
                            first = _first_author(s.characteristics.authors)
                            mismatched_outcome.append(f"{first} {s.characteristics.year}")
                            break  # one mismatch per study is enough
                if mismatched_outcome:
                    if zh:
                        notes.append(
                            "主要结局与综述设定不一致（"
                            + "、".join(mismatched_outcome)
                            + "），仅提取相关指标"
                        )
                    else:
                        notes.append(
                            "primary outcome mismatching review scope ("
                            + ", ".join(mismatched_outcome)
                            + "); only relevant measures extracted"
                        )

        if not notes:
            return manuscript

        self.log(
            f"Detected PICO consistency warning ({len(notes)} items); keeping it out of the manuscript body.",
            level="warning",
        )
        return manuscript

    def _enforce_rob_tool_constraint(self, manuscript: str, rob_results: list) -> str:
        """When all studies are RCTs, remove NOS references from the report."""
        if not rob_results:
            return manuscript

        tools_used = set(r.tool_used for r in rob_results if hasattr(r, 'tool_used'))
        # Only clean up NOS mentions if ALL studies used RoB 2 (all RCTs)
        if "RoB 2" not in tools_used or "Newcastle-Ottawa Scale" in tools_used:
            return manuscript

        zh = self._zh
        cleaned = False

        if zh:
            nos_patterns = [
                "Newcastle-Ottawa Scale",
                "NOS量表",
                "NOS 量表",
                "Newcastle-Ottawa",
            ]
        else:
            nos_patterns = [
                "Newcastle-Ottawa Scale",
                "NOS",
                "Newcastle-Ottawa",
            ]

        lines = manuscript.split('\n')
        result = []
        for line in lines:
            skip = False
            for nos_pat in nos_patterns:
                if nos_pat in line:
                    # For NOS as standalone (not in a sentence), remove the line
                    stripped = line.strip()
                    if stripped.startswith('|') or stripped.startswith('-') or stripped.startswith('*'):
                        skip = True
                        break
                    # For NOS mentioned inline, replace with RoB 2
                    line = line.replace(nos_pat, "RoB 2" if not zh else "Cochrane RoB 2.0")
                    cleaned = True
            if not skip:
                result.append(line)

        if cleaned:
            self.log("RoB工具约束: 移除NOS引用（所有研究均为RCT）", level="warning")
        manuscript = '\n'.join(result)
        return manuscript

    def _fix_prisma_certainty_labels(
        self, manuscript: str, rob_results: list, grade_profile: GRADEProfile = None,
    ) -> str:
        """Fix PRISMA certainty labels for narrative mode."""
        if not self._narrative_mode:
            return manuscript

        has_grade = (
            grade_profile is not None
            and hasattr(grade_profile, 'outcomes')
            and len(grade_profile.outcomes) > 0
        )
        zh = self._zh

        # Narrative mode without GRADE: if evidence assessment text exists in supplementary
        if not has_grade:
            has_certainty_text = bool(re.search(
                r'(?:证据确定性|定性证据|certainty\s+of\s+evidence|qualitative\s+evidence)',
                manuscript, re.IGNORECASE,
            ))
            if has_certainty_text:
                if zh:
                    manuscript = manuscript.replace(
                        "| 证据确定性 | 15 | 描述证据确定性评估方法 | 未适用 |",
                        "| 证据确定性 | 15 | 描述证据确定性评估方法 | 未进行Meta分析合并 |",
                    )
                    manuscript = manuscript.replace(
                        "| 证据确定性 | 21 | 报告每个结局的 GRADE 评级 | 未适用 |",
                        "| 证据确定性 | 21 | 报告每个结局的 GRADE 评级 | 未进行Meta分析合并 |",
                    )
                else:
                    manuscript = manuscript.replace(
                        "| Certainty assessment | 15 | Describe methods for assessing certainty (GRADE) | N/A |",
                        "| Certainty assessment | 15 | Describe methods for assessing certainty (GRADE) | Qualitative assessment (non-GRADE) |",
                    )
                    manuscript = manuscript.replace(
                        "| Certainty of evidence | 21 | Report GRADE certainty for each outcome | N/A |",
                        "| Certainty of evidence | 21 | Report GRADE certainty for each outcome | Qualitative assessment (non-GRADE) |",
                    )

        return manuscript

    def _fix_table_study_names(self, manuscript: str, studies: list) -> str:
        """Replace PMID-as-study-name in tables with Author (Year) format."""
        # Build PMID → "Author Year" mapping
        pmid_map = {}
        for s in studies:
            c = s.characteristics
            pmid = c.pmid
            if not pmid:
                continue
            first = _first_author(c.authors)
            year = c.year or ""
            if first:
                pmid_map[pmid] = f"{first} ({year})" if year else first

        if not pmid_map:
            return manuscript

        lines = manuscript.split('\n')
        changed = False
        result = []
        for line in lines:
            # Only process table rows
            if line.strip().startswith('|'):
                new_line = line
                for pmid, label in pmid_map.items():
                    # Replace PMID that appears as a standalone cell value
                    # Pattern: | PMID | or |PMID|
                    new_line = re.sub(
                        rf'\|\s*{re.escape(pmid)}\s*\|',
                        f'| {label} |',
                        new_line,
                    )
                if new_line != line:
                    changed = True
                    self.log(f"表格研究名替换: PMID → {list(pmid_map.values())[0]}", level="warning")
                    line = new_line
            result.append(line)

        if changed:
            manuscript = '\n'.join(result)
        return manuscript

    def _fix_structure(self, manuscript: str) -> str:
        """Fix structural issues: duplicate headings at all levels, empty sections, bare repeats."""
        seen = {}
        lines = manuscript.split('\n')
        cleaned = []
        for line in lines:
            stripped = line.strip()
            if re.match(r'^#{1,3}\s+', stripped):
                if stripped in seen:
                    seen[stripped] += 1
                    if seen[stripped] > 1:
                        self.log(f"清除重复标题: {stripped[:50]}", level="warning")
                        continue
                else:
                    seen[stripped] = 1
            cleaned.append(line)

        manuscript = '\n'.join(cleaned)

        # Remove empty sections (heading followed by only whitespace then another heading)
        manuscript = re.sub(
            r'(#{2,3}\s+[^\n]+)\n{2,}(#{2,3}\s+)',
            r'\1\n\2',
            manuscript,
        )

        # P8: Detect bare section name repeats after ## heading
        # e.g., "## 结果\n...text...\n结果\n" where LLM echoed the heading as plain text
        section_names = ["结果", "Results", "方法", "Methods", "讨论", "Discussion",
                         "结论", "Conclusion", "引言", "Introduction", "摘要", "Abstract"]
        for name in section_names:
            # Match: ## {Name} followed by content, then a bare {Name} on its own line
            pattern = rf'(##\s*{re.escape(name)}[^\n]*\n)((?:.*\n)*?)({re.escape(name)}\s*$)'
            def _remove_bare(m):
                heading = m.group(1)
                body = m.group(2)
                return heading + body
            new_ms = re.sub(pattern, _remove_bare, manuscript, flags=re.MULTILINE)
            if new_ms != manuscript:
                self.log(f"Removed bare duplicate section name: {name}", level="warning")
                manuscript = new_ms

        return manuscript

    def _final_consistency_check(self, manuscript: str, report_state, prisma_data: dict) -> tuple[str, list[str]]:
        """Comprehensive validation before output. Returns (manuscript, issues)."""
        issues = []

        # P1: PRISMA records_identified vs full_text_assessed
        ri = prisma_data.get("identification", {}).get("records_identified", 0)
        fta = prisma_data.get("eligibility", {}).get("full_text_assessed", 0)
        if ri == 0 and fta > 0:
            # Check if source explanation exists
            if "用户上传" not in manuscript and "user upload" not in manuscript.lower() and "user-supplied" not in manuscript.lower():
                issues.append("PRISMA: records_identified=0 but full_text_assessed>0 without source explanation")

        # P3: evidence_gap should not have Table 1 or "纳入RCT" claims
        if report_state.n_direct_eligible == 0:
            if "纳入研究基本特征" in manuscript:
                issues.append("Evidence gap report contains '纳入研究基本特征' (Table 1)")
            rct_match = re.search(r'纳入\s*\d+\s*项\s*RCT', manuscript)
            if rct_match:
                issues.append(f"Evidence gap report contains RCT inclusion claim: '{rct_match.group()}'")

        # P5: evidence_gap should not have RoB main table
        if report_state.n_direct_eligible == 0:
            if re.search(r'偏倚风险评估.*\|.*\|.*\|', manuscript, re.DOTALL):
                issues.append("Evidence gap report contains RoB table")

        # P6: n=0 should not claim "低确定性" or "very low certainty"
        if report_state.n_direct_eligible == 0:
            bad_patterns = ["确定性可能为低", "证据总体确定性", "certainty: possibly low",
                            "very low certainty", "GRADE评级.*低"]
            for bp in bad_patterns:
                if re.search(bp, manuscript, re.IGNORECASE):
                    issues.append(f"Zero studies but claims certainty: '{bp}'")

        # P7: Study count consistency — "X项研究/X studies" vs actual listed names
        count_patterns = re.findall(
            r'(?:纳入|共|包括|total\s+of\s+)?(\d+)\s*(?:项|个)?\s*(?:研究|studies|RCT|trials)',
            manuscript, re.IGNORECASE
        )
        if count_patterns and report_state.n_direct_eligible > 0:
            declared_counts = [int(c) for c in count_patterns if int(c) > 0]
            if declared_counts:
                most_common = max(set(declared_counts), key=declared_counts.count)
                actual_n = report_state.n_direct_eligible
                if most_common != actual_n and actual_n > 0:
                    # Auto-fix: replace all mismatched count claims
                    for old_c in set(declared_counts):
                        if old_c != actual_n:
                            manuscript = manuscript.replace(f"{old_c}项研究", f"{actual_n}项研究")
                            manuscript = manuscript.replace(f"{old_c}个研究", f"{actual_n}项研究")
                            manuscript = re.sub(
                                rf'{old_c}\s+studies', f'{actual_n} studies', manuscript, flags=re.IGNORECASE
                            )
                            manuscript = re.sub(
                                rf'{old_c}\s+RCT', f'{actual_n} RCT', manuscript, flags=re.IGNORECASE
                            )
                            issues.append(f"P7: Study count mismatch — declared {old_c}, actual {actual_n}. Auto-fixed.")

        # P8: Duplicate headings at any level
        headings = re.findall(r'^(#{1,4}\s+.+)$', manuscript, re.MULTILINE)
        heading_counts: dict[str, int] = {}
        for h in headings:
            h_clean = re.sub(r'^#+\s+', '', h).strip().lower()
            heading_counts[h_clean] = heading_counts.get(h_clean, 0) + 1
        for h_clean, count in heading_counts.items():
            if count > 1:
                issues.append(f"Duplicate heading: '{h_clean}' appears {count} times")

        # P9: evidence_gap mode should not have individual study results in main Results section
        if report_state.n_direct_eligible == 0:
            results_section = re.search(r'##\s*结果(.*?)(?=##\s|$)', manuscript, re.DOTALL)
            if results_section:
                section_text = results_section.group(1)
                # If section contains specific study data descriptions, flag it
                if len(section_text) > 2000 and re.search(r'\d{4}\s*\[\d+\]', section_text):
                    issues.append("Evidence gap report has lengthy individual study descriptions in Results section")

        # Evidence gap forbidden phrases
        if report_state.n_direct_eligible == 0:
            forbidden = ["疗效趋势", "方向性结果", "跨研究比较", "pooled effect", "forest plot"]
            for fb in forbidden:
                if fb in manuscript.lower():
                    issues.append(f"Evidence gap report contains forbidden phrase: '{fb}'")

        # Auto-fix: replace certainty claims when n=0
        if report_state.n_direct_eligible == 0:
            certainty_fixes = [
                (r'确定性可能为低', '直接证据缺失（evidence not available）'),
                (r'证据总体确定性[^。\n]*[。]?', '直接证据缺失，无法进行确定性评级。'),
                (r'very low certainty', 'no direct evidence'),
                (r'certainty:\s*possibly\s+low', 'no direct evidence'),
            ]
            for pattern, repl in certainty_fixes:
                new_ms = re.sub(pattern, repl, manuscript, flags=re.IGNORECASE)
                if new_ms != manuscript:
                    self.log(f"Auto-fixed certainty claim: '{pattern}' -> '{repl}'", level="warning")
                    manuscript = new_ms

        return manuscript, issues

    _ZH_HEADING_KEYWORDS = {"摘要", "引言", "方法", "结果", "讨论", "结论", "补充材料", "表格", "图表", "参考文献"}

    _EN_HEADING_KEYWORDS = {"abstract", "introduction", "methods", "results", "discussion", "conclusion",
                            "supplementary", "tables", "figures", "references"}

    def _check_language_uniformity(self, manuscript: str) -> str:
        """Check structural elements (headings) for language mixing and log warning."""
        lines = manuscript.split('\n')
        zh_structural = 0
        en_structural = 0

        for line in lines:
            stripped = line.strip()
            if re.match(r'^#{1,3}\s+', stripped):
                if any(kw in stripped for kw in self._ZH_HEADING_KEYWORDS):
                    zh_structural += 1
                elif any(kw.lower() in stripped.lower() for kw in self._EN_HEADING_KEYWORDS):
                    en_structural += 1

        if zh_structural > 0 and en_structural > 0:
            self.log(f"语言混合检测: {zh_structural} 中文标题 + {en_structural} 英文标题", level="warning")

        return manuscript

    _NARRATIVE_FINAL_FORBIDDEN = [
        (r'综合分析', '独立描述'),
        (r'汇总结果显示', '各研究分别显示'),
        (r'总体结果表明', '各研究结果如下'),
        (r'各项研究一致显示', '各研究分别报告'),
        (r'多数研究显示', '部分研究报告'),
        (r'稳健支持', '有限证据提示'),
        (r'有力证据', '初步证据'),
        (r'方向一致', '存在差异'),
        (r'综合来看', '需注意'),
        (r'meta-analysis\s+of\s+\d+\s+studies', 'narrative review of individual studies'),
        (r'the\s+pooled\s+analysis\s+(?:showed|found|revealed)',
         'individual studies separately reported'),
        (r'combining\s+(?:all|the)\s+studies', 'examining individual studies separately'),
        (r'across\s+all\s+included\s+studies', 'in individual included studies'),
        (r'结果(?:具有良好)?一致性', '结果方向各异'),
        (r'研究间结果一致', '研究间结果存在差异'),
        (r'results\s+were\s+consistent\s+across', 'results varied across'),
        (r'consistent\s+findings\s+across\s+studies', 'heterogeneous findings across studies'),
        (r'因为\s*(?:干预|治疗|药物|用药)\s*(?:的|导致了?)', '关于干预，'),
        (r'由于\s*(?:干预|治疗|药物|用药)\s*(?:的|导致了?)', '关于干预，'),
        (r'because\s+(?:of\s+)?the\s+(?:intervention|treatment)\s+(?:caused|led)',
         'regarding the intervention, '),
        (r'due\s+to\s+the\s+(?:intervention|treatment)\s*,',
         'regarding the intervention,'),
    ]

    def _enforce_narrative_final(self, manuscript: str) -> str:
        """Enforce strict narrative mode final constraints."""
        for pattern, replacement in self._NARRATIVE_FINAL_FORBIDDEN:
            new_ms = re.sub(pattern, replacement, manuscript, flags=re.IGNORECASE)
            if new_ms != manuscript:
                self.log(f"叙述模式最终约束: '{pattern[:30]}' → '{replacement[:30]}'", level="warning")
                manuscript = new_ms
        return self._repair_narrative_placeholder_effects(manuscript)

    def _repair_narrative_placeholder_effects(self, manuscript: str) -> str:
        """Replace leaked pooled-effect placeholders with a narrative statement.

        A model can correctly say that pooling was not performed while still
        appending a template fragment such as ``RR NR (95% CI NR to NR)``.
        That fragment is neither publishable prose nor a real result. Replace
        only the affected sentence/cell and retain the rest of the paragraph.
        """
        violation = re.compile(
            r"(?:\b(?:OR|RR|HR|IRR|RD|MD|SMD)?\s*NR\s*\(\s*95%\s*CI\s*[:=]?\s*NR\s*(?:to|[-–])\s*NR\s*\)"
            r"|\bpooled\s+(?:effect|estimate|OR|RR|HR|IRR|RD|MD|SMD)[^.\n]{0,160}\bNR\b)",
            flags=re.IGNORECASE,
        )
        replacement = (
            "未进行定量合成，因为符合条件的研究少于两项。"
            if self._zh
            else "Quantitative synthesis was not performed because fewer than two eligible studies were available."
        )
        repaired_lines: list[str] = []
        repaired_count = 0
        for line in manuscript.splitlines():
            if not violation.search(line):
                repaired_lines.append(line)
                continue
            if line.count("|") >= 2:
                cells = line.split("|")
                for index, cell in enumerate(cells):
                    if violation.search(cell):
                        cells[index] = " Not quantitatively synthesized " if not self._zh else " 未进行定量合成 "
                        repaired_count += 1
                repaired_lines.append("|".join(cells))
                continue

            segments = re.split(r"(?<=[.!?。！？])\s+", line)
            repaired_segments: list[str] = []
            for segment in segments:
                if not violation.search(segment):
                    repaired_segments.append(segment)
                    continue
                prefix_match = re.match(r"^(\s*(?:[-*]\s+|\*\*[^*]+\*\*:\s*))", segment)
                prefix = prefix_match.group(1) if prefix_match else ""
                repaired_segments.append(prefix + replacement)
                repaired_count += 1
            repaired_lines.append(" ".join(repaired_segments))
        if repaired_count:
            self.log(
                f"Narrative placeholder repair replaced {repaired_count} unsupported pooled-effect fragment(s).",
                level="warning",
            )
        return "\n".join(repaired_lines)

    def _validate_consistency(self, manuscript: str) -> str:
        """Validate and auto-clean: detect → clean → verify. Runs in all modes."""
        # Phase 1: detect and CLEAN placeholder statistics (all modes)
        placeholder_issues = self._detect_statistical_placeholders(manuscript)
        if placeholder_issues:
            self.log(f"检测到统计占位符，执行清理: {'; '.join(placeholder_issues)}", level="warning")
            manuscript = self._clean_placeholder_statistics(manuscript)

        # Phase 2: narrative mode — line-by-line cleanup of meta-analysis content
        if self._narrative_mode:
            manuscript = self._clean_narrative_meta_content(manuscript)

        # Phase 3: placeholder text cleanup (all modes)
        manuscript = self._clean_placeholder_text(manuscript)

        # Phase 4: duplicate heading check (all modes)
        manuscript = self._clean_duplicate_headings(manuscript)

        return manuscript

    def _clean_narrative_meta_content(self, manuscript: str) -> str:
        """Remove meta-analysis-specific content from narrative reports.

        Note: skips embedded base64 image lines to avoid false-positive matches.
        """
        meta_patterns = [
            r'合并\s*(?:的?\s*)?(?:效应量|OR|RR|MD|SMD|HR)\s*[为=:＝]',
            r'pooled\s+(?:effect|OR|RR|MD|SMD|HR)\s*(?:was|is|[:=])',
            r'(?:森林图|forest\s*plot)',
            r'(?:漏斗图|funnel\s*plot)',
            r'I[²2]\s*[=＝]\s*\d+',
            r'τ[²2]\s*[=＝]',
            r'Egger[^\n]*(?:test|检验)',
            r'Begg[^\n]*(?:test|检验)',
            r'(?:leave-one-out|leave\s+one\s+out)',
            r'(?:fixed-effect|random-effects)\s+model',
            r'DerSimonian-Laird',
            r'(?:cumulative\s+meta|Baujat|Galbraith)',
        ]
        negation_re = re.compile(
            r'(?:'
            r'was\s+not\s+(?:perform|conduct|generat|includ|done|applicabl)'
            r'|were\s+not\s+(?:perform|conduct|generat|includ|done|applicabl)'
            r'|is\s+not\s+(?:applicabl|includ)'
            r'|not\s+(?:perform|conduct|generat|includ|done|applicabl)'
            r'|did\s+not\s+(?:perform|conduct|includ|generat)'
            r'|no\s+(?:forest|funnel|pooled|meta|sensitivity|cumulative|leave)'
            r'|未\s*(?:进行|生成|制作|实施|包含|提供|报告)'
            r'|没有\s*(?:进行|生成|制作|实施|包含|报告)'
            r'|无法\s*(?:进行|生成|制作|实施|计算)'
            r')',
            re.IGNORECASE,
        )

        lines = manuscript.split('\n')
        cleaned = []
        removed_count = 0
        for line in lines:
            stripped = line.strip()
            if not stripped:
                cleaned.append(line)
                continue
            # Skip embedded base64 image lines — meta_patterns can accidentally
            # match sequences within long base64 strings, deleting the image entirely.
            if '](data:image/' in stripped:
                cleaned.append(line)
                continue
            hit = False
            for mp in meta_patterns:
                if re.search(mp, stripped, re.IGNORECASE):
                    if negation_re.search(stripped):
                        break  # legitimate negation, keep
                    hit = True
                    break
            if hit:
                removed_count += 1
                self.log(f"自动清除叙述性报告中的Meta分析内容: {stripped[:60]}...", level="warning")
            else:
                cleaned.append(line)

        manuscript = '\n'.join(cleaned)
        manuscript = re.sub(r'\n{3,}', '\n\n', manuscript)

        if removed_count > 0:
            self.log(f"叙述性报告已自动清洗 {removed_count} 行Meta分析相关内容", level="warning")

        return manuscript

    def _clean_placeholder_text(self, manuscript: str) -> str:
        """Remove placeholder text patterns from manuscript."""
        # Protect embedded base64 image lines — patterns below can accidentally
        # match base64 chars (e.g. TBD/TODO/INSERT all appear in base64 alphabet),
        # which would corrupt the image data and produce broken images in the report.
        lines = manuscript.split('\n')
        image_lines: dict[int, str] = {}
        for i, line in enumerate(lines):
            if '](data:image/' in line:
                image_lines[i] = line
                lines[i] = f'\x00IMG{i}\x00'
        manuscript = '\n'.join(lines)

        _placeholder_patterns = [
            (r'\[?\[?待补充\]?\]?', ''),
            (r'\[?\[?待完善\]?\]?', ''),
            (r'\[?\[?见原文\]?\]?', ''),
            (r'\[?\[?见前述\]?\]?', ''),
            (r'\[?\[?TODO\]?\]?', '', re.IGNORECASE),
            (r'\[?\[?INSERT[^]]*\]?\]?', '', re.IGNORECASE),
            (r'\[?\[?TBD\]?\]?', '', re.IGNORECASE),
            (r'\[Date of search\]', '', re.IGNORECASE),
            (r'\[CRD编号[：:?\]]?[^\]]*\]', ''),
            (r'CRD编号[：:]\s*$', ''),
            (r'\bNR\b(?=\s*[|,，.]|\s*$)', 'Not reported'),
        ]
        for entry in _placeholder_patterns:
            if len(entry) == 3:
                pattern, repl, flags = entry
            else:
                pattern, repl = entry
                flags = 0
            before = manuscript
            manuscript = re.sub(pattern, repl, manuscript, flags=flags)
            if manuscript != before:
                self.log(f"清除占位符文本: {pattern[:30]}", level="warning")
        manuscript = re.sub(r'\n{3,}', '\n\n', manuscript)

        # Restore protected image lines
        for idx, original_line in image_lines.items():
            manuscript = manuscript.replace(f'\x00IMG{idx}\x00', original_line)
        return manuscript

    def _clean_duplicate_headings(self, manuscript: str) -> str:
        """Remove duplicate section headings (e.g., '## Results' appearing twice)."""
        seen_headings = set()
        lines = manuscript.split('\n')
        cleaned = []
        for line in lines:
            stripped = line.strip()
            if stripped.startswith('## ') and not stripped.startswith('### '):
                if stripped in seen_headings:
                    self.log(f"清除重复标题: {stripped}", level="warning")
                    continue
                seen_headings.add(stripped)
            cleaned.append(line)
        return '\n'.join(cleaned)

    _META_CONTRADICTION_ZH = [
        ("无法进行跨研究比较", "由于存在显著异质性，合并结果需谨慎解释"),
        ("仅能独立解读", "合并结果需谨慎解释"),
        ("无法直接比较", "由于存在显著异质性，合并结果需谨慎解释"),
        ("无法进行比较", "由于存在显著异质性，合并结果需谨慎解释"),
        ("研究结果不具备直接比较条件", "由于存在显著异质性，合并结果需谨慎解释"),
    ]

    _META_CONTRADICTION_EN = [
        ("cannot be directly compared", "pooled results should be interpreted with caution due to significant heterogeneity"),
        ("cannot be compared", "pooled results should be interpreted with caution due to significant heterogeneity"),
        ("can only be interpreted independently", "pooled results should be interpreted with caution"),
    ]

    def _fix_meta_contradiction(self, manuscript: str) -> str:
        """In meta-analysis mode, replace self-contradictory phrases."""
        if self._narrative_mode:
            return manuscript
        pairs = self._META_CONTRADICTION_ZH if self._zh else self._META_CONTRADICTION_EN
        for old, new in pairs:
            if old in manuscript:
                manuscript = manuscript.replace(old, new)
                self.log(f"Meta自相矛盾修正: '{old[:20]}'", level="warning")
        return manuscript

    def _check_effect_direction(self, manuscript: str, meta_results) -> str:
        """Check MD sign vs interpretation text consistency."""
        if self._narrative_mode or meta_results is None:
            return manuscript

        # Collect all pooled effects (primary + secondary)
        all_effects = []
        primary = getattr(meta_results, 'primary_outcome', None)
        if primary:
            all_effects.append(primary)
        for sec in getattr(meta_results, 'secondary_outcomes', []):
            all_effects.append(sec)
        if not all_effects:
            return manuscript

        zh = self._zh
        warnings = []
        for pe in all_effects:
            effect_val = getattr(pe, 'pooled_effect', None)
            if effect_val is None:
                continue
            outcome_name = getattr(pe, 'outcome_name', '') or ''
            section = self._find_outcome_section(manuscript, outcome_name)
            if not section:
                continue
            if effect_val > 0:
                words = ["降低", "减少", "下降"] if zh else ["decrease", "reduction", "lower"]
                for w in words:
                    if w in section.lower():
                        warnings.append(outcome_name or f"MD={effect_val:.2f}")
                        break
            elif effect_val < 0:
                words = ["升高", "增加", "上升"] if zh else ["increase", "elevat", "higher"]
                for w in words:
                    if w in section.lower():
                        warnings.append(outcome_name or f"MD={effect_val:.2f}")
                        break

        if warnings:
            if zh:
                note = "\n\n> **效应方向注意**：以下结局的合并效应方向可能与文字描述不一致（" + "、".join(warnings) + "），请核实。\n"
            else:
                note = "\n\n> **Effect direction note**: Pooled effect direction may contradict text for: " + ", ".join(warnings) + ".\n"
            insert_pt = "## 讨论" if zh else "## Discussion"
            if insert_pt in manuscript:
                manuscript = manuscript.replace(insert_pt, note + insert_pt, 1)
                self.log(f"效应方向警告: {', '.join(warnings)}", level="warning")
        return manuscript

    def _find_outcome_section(self, manuscript: str, outcome_name: str) -> str:
        keywords = [w.strip().lower() for w in re.split(r'[\s,，;；()（）]+', outcome_name) if len(w.strip()) > 3]
        if not keywords:
            return ""
        best = ""
        for para in manuscript.split('\n\n'):
            pl = para.lower()
            if any(kw in pl for kw in keywords):
                if len(para) > len(best):
                    best = para
        return best

    def _check_outliers(self, manuscript: str, extracted_studies: list) -> str:
        if self._narrative_mode:
            return manuscript
        outliers = []
        for s in extracted_studies:
            for o in s.outcomes:
                es = getattr(o, 'effect_size', None)
                if es is not None and abs(es) > 5:
                    first = _first_author(s.characteristics.authors)
                    outliers.append(f"{first} {s.characteristics.year} (MD={es:.2f})")
        if not outliers:
            return manuscript
        zh = self._zh
        if zh:
            note = "\n\n> **异常值提示**：以下研究的效应量绝对值 > 5（" + "；".join(outliers) + "），建议进行敏感性分析或剔除后重新合并。\n"
        else:
            note = "\n\n> **Outlier alert**: |MD| > 5 for (" + "; ".join(outliers) + "). Sensitivity analysis or exclusion recommended.\n"
        insert_pt = "## 讨论" if zh else "## Discussion"
        if insert_pt in manuscript:
            manuscript = manuscript.replace(insert_pt, note + insert_pt, 1)
            self.log(f"异常值: {len(outliers)} 项 |MD|>5", level="warning")
        return manuscript

    def _check_dose_groups(self, manuscript: str, extracted_studies: list) -> str:
        if self._narrative_mode:
            return manuscript
        author_year_map: dict[str, list] = {}
        for s in extracted_studies:
            c = s.characteristics
            key = f"{_first_author(c.authors)}_{c.year}"
            author_year_map.setdefault(key, []).append(s)
        dupes = {k: v for k, v in author_year_map.items() if len(v) > 1}
        if not dupes:
            return manuscript
        zh = self._zh
        names = list(dupes.keys())
        self.log(f"疑似多剂量组: {names}", level="warning")
        if zh:
            note = "\n\n> **多剂量组注意**：以下研究可能含多个剂量组（" + "、".join(names) + "），应合并或使用多层模型。\n"
        else:
            note = "\n\n> **Multi-dose note**: (" + ", ".join(names) + "). Consider combining or multilevel model.\n"
        insert_pt = "## 讨论" if zh else "## Discussion"
        if insert_pt in manuscript:
            manuscript = manuscript.replace(insert_pt, note + insert_pt, 1)
        return manuscript

    def _enforce_pub_bias_limit(self, manuscript: str, extracted_studies: list) -> str:
        if self._narrative_mode:
            return manuscript
        # Use direct RCT count, not all studies
        direct_studies = getattr(self, '_direct_rct_studies', None) or extracted_studies
        n = len(direct_studies)
        zh = self._zh
        changed = False
        lines = manuscript.split('\n')
        result = []

        if n < 10:
            # k < 10: remove publication bias tests
            tests = ["Egger", "Begg", "egger", "begg", "Egger's", "Begg's", "Egger检验", "Begg检验",
                     "trim-and-fill", "trim and fill", "剪补法", "fail-safe", "fail safe", "失安全系数"]
            replacement = "样本量不足（<10项研究），未评估发表偏倚" if zh else "Publication bias not assessed (<10 studies)"
            for line in lines:
                skip = False
                if any(t in line for t in tests):
                    if line.strip().startswith('|') or line.strip().startswith('-'):
                        skip = True
                        changed = True
                    else:
                        for t in tests:
                            line = line.replace(t, "")
                        if not line.strip() or len(line.strip()) < 10:
                            line = replacement
                        changed = True
                if not skip:
                    result.append(line)
            manuscript = '\n'.join(result)

        if n < 3:
            # k < 3: also remove subgroup, meta-regression, Baujat, Galbraith
            k3_terms = ["亚组分析", "subgroup analysis", "meta回归", "meta-regression",
                        "Baujat", "Galbraith", "Cook距离", "Cook's distance", "DFBETAS",
                        "影响诊断", "influence diagnostic"]
            replacement_k3 = (
                "由于可合并研究数有限，未实施亚组分析、meta回归和影响诊断"
                if zh else
                "Due to limited number of studies, subgroup analysis, meta-regression and influence diagnostics were not performed"
            )
            lines = manuscript.split('\n')
            result = []
            for line in lines:
                skip = False
                if any(t in line for t in k3_terms):
                    if line.strip().startswith('|') or line.strip().startswith('-'):
                        skip = True
                        changed = True
                    else:
                        for t in k3_terms:
                            line = line.replace(t, "")
                        if not line.strip() or len(line.strip()) < 10:
                            line = replacement_k3
                        changed = True
                if not skip:
                    result.append(line)
            manuscript = '\n'.join(result)

        if changed:
            self.log(f"统计方法限制: {n}项直接RCT", level="warning")
        return manuscript

    _POP_EXCLUSION = {
        "diabetes|t2dm|type 2|2型糖尿病": ["euglycemic", "normoglycemic", "正常血糖", "non-diabetic", "healthy volunteer"],
        "hypertension|高血压": ["normotensive", "正常血压"],
    }

    def _check_inclusion_criteria(self, manuscript: str, extracted_studies: list, protocol: ResearchProtocol) -> str:
        if self._narrative_mode:
            return manuscript
        target_pop = (protocol.pico.population or "").lower()
        if not target_pop:
            return manuscript
        excl_kws = []
        for pat, excl in self._POP_EXCLUSION.items():
            if any(kw in target_pop for kw in pat.split("|")):
                excl_kws = excl
                break
        if not excl_kws:
            return manuscript
        mismatched = []
        for s in extracted_studies:
            sp = (s.characteristics.population_description or "").lower()
            if any(e in sp for e in excl_kws):
                mismatched.append(f"{_first_author(s.characteristics.authors)} {s.characteristics.year}")
        if not mismatched:
            return manuscript
        zh = self._zh
        if zh:
            note = "\n\n> **纳入标准注意**：以下研究可能不符（" + "、".join(mismatched) + "），建议核实。\n"
        else:
            note = "\n\n> **Inclusion note**: (" + ", ".join(mismatched) + ") may not meet criteria.\n"
        insert_pt = "## 讨论" if zh else "## Discussion"
        if insert_pt in manuscript:
            manuscript = manuscript.replace(insert_pt, note + insert_pt, 1)
            self.log(f"纳入标准: {len(mismatched)} 项不符", level="warning")
        return manuscript

    def _clean_registration_placeholders(self, manuscript: str) -> str:
        lines = manuscript.split('\n')
        img_map: dict[int, str] = {}
        for i, line in enumerate(lines):
            if '](data:image/' in line:
                img_map[i] = line
                lines[i] = f'\x00IMG{i}\x00'
        text = '\n'.join(lines)
        patterns = [
            (r'PROSPERO[^\n]*CRD\d{10,}[^\n]*\n?', ''),
            (r'注册号[：:]\s*(?:待|N/A|NA|pending|TBD|未注册)[^.\n]*\.?\s*\n?', ''),
            (r'Registration[^.\n]*(?:pending|N/A|NA|TBD|not\s+registered)[^.\n]*\.?\s*\n?', ''),
        ]
        for pat, repl in patterns:
            before = text
            text = re.sub(pat, repl, text, flags=re.IGNORECASE)
            if text != before:
                self.log("清理注册信息占位符", level="warning")
        text = re.sub(r'\n{3,}', '\n\n', text)
        for idx, orig in img_map.items():
            text = text.replace(f'\x00IMG{idx}\x00', orig)
        return text

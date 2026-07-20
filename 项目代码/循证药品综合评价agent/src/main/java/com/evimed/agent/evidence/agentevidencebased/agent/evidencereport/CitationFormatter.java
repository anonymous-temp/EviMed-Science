package com.evimed.agent.evidence.agentevidencebased.agent.evidencereport;

import com.evimed.agent.evidence.agentevidencebased.tools.EvidenceRetrievalTool;
import lombok.extern.slf4j.Slf4j;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 文献引用格式化工具
 *
 * 负责：
 * 1. 重新编号：按正文首次出现顺序将 [N] 重新编号为 [1], [2], [3]...
 * 2. 生成参考文献列表：格式化为标准引用格式
 */
@Slf4j
public class CitationFormatter {

    private static final Pattern CITATION_PATTERN = Pattern.compile("\\[(\\d+)\\]");
    // 支持三种格式：纯 MongoDB ID、复合格式（数字_数字_ID）、纯数字_ID
    private static final Pattern ID_CITATION_PATTERN = Pattern.compile("\\[(?:\\d+_)?(?:\\d+_)?([a-f0-9]{24})\\]");

    /**
     * 重新编号并生成参考文献
     *
     * @param reportBody 报告正文
     * @param registry   引用注册表
     * @return String[2]: [0]=重新编号后的正文, [1]=参考文献区块
     */
    public static String[] resequenceAndFormat(String reportBody, CitationRegistry registry) {
        if (registry == null || registry.isEmpty()) {
            return new String[]{reportBody, ""};
        }

        // 0. 先将 MongoDB ID 格式的引用替换为注册表编号
        String preprocessed = replaceIdCitations(reportBody, registry);

        // 1. 按首次出现顺序收集被引用的旧编号，建立 oldNum → newNum 映射
        LinkedHashMap<Integer, Integer> oldToNew = new LinkedHashMap<>();
        Matcher m = CITATION_PATTERN.matcher(preprocessed);
        int seq = 1;

        while (m.find()) {
            int old;
            try {
                old = Integer.parseInt(m.group(1));
            } catch (NumberFormatException e) {
                continue;
            }
            if (!oldToNew.containsKey(old) && registry.getItem(old) != null) {
                oldToNew.put(old, seq++);
            }
        }

        if (oldToNew.isEmpty()) {
            return new String[]{reportBody, ""};
        }

        // 2. 替换正文中的 [N] 为新编号（使用临时占位符避免冲突）
        String updated = reportBody;
        for (Map.Entry<Integer, Integer> e : oldToNew.entrySet()) {
            updated = updated.replace("[" + e.getKey() + "]", "%%REF" + e.getValue() + "%%");
        }
        updated = updated.replaceAll("%%REF(\\d+)%%", "[$1]");

        // 3. 生成参考文献列表
        StringBuilder refs = new StringBuilder("\n\n## 参考文献\n\n");
        for (Map.Entry<Integer, Integer> e : oldToNew.entrySet()) {
            EvidenceRetrievalTool.EvidenceItem item = registry.getItem(e.getKey());
            if (item == null) continue;
            refs.append(String.format("[%d] %s\n\n", e.getValue(), formatReference(item)));
        }

        return new String[]{updated, refs.append("\n").toString()};
    }

    /**
     * 格式化单条文献引用
     */
    private static String formatReference(EvidenceRetrievalTool.EvidenceItem item) {
        String source = item.getSource() != null ? item.getSource() : "";
        String title = stripTrailingDot(item.getTitle() != null ? item.getTitle() : "未知标题");
        String year = item.getYear() != null ? item.getYear() : "";

        if ("GUIDE".equals(source)) {
            return title + "." + (year.isBlank() ? "" : " " + year + ".");
        }

        if ("INSTRUCTION".equals(source)) {
            return title + " [药品说明书]." + (year.isBlank() ? "" : " " + year + ".");
        }

        // ES_BM25 / BLOCK：使用 raw 字段拼装
        Map<String, String> raw = item.getRaw();
        String journal = stripTrailingDot(
                (raw != null && raw.get("journal") != null) ? raw.get("journal") : "");

        StringBuilder ref = new StringBuilder(title).append(".");
        if (!journal.isBlank()) ref.append(" ").append(journal).append(",");
        if (!year.isBlank()) ref.append(" ").append(year).append(".");

        return ref.toString();
    }

    /** 去掉字符串末尾的句点，避免拼接时产生 ".." */
    private static String stripTrailingDot(String s) {
        if (s != null && s.endsWith(".")) {
            return s.substring(0, s.length() - 1);
        }
        return s;
    }

    /**
     * 将 MongoDB ID 格式的引用（如 [66ea91a0601dc9e326432f90]）替换为注册表编号（如 [1]）
     */
    private static String replaceIdCitations(String text, CitationRegistry registry) {
        Matcher m = ID_CITATION_PATTERN.matcher(text);
        StringBuffer sb = new StringBuffer();

        while (m.find()) {
            String id = m.group(1);
            Integer num = registry.getNum(id);
            if (num != null) {
                m.appendReplacement(sb, "[" + num + "]");
                log.debug("替换 ID 引用: [{}] → [{}]", id, num);
            } else {
                log.warn("未找到 ID 对应的注册编号: {}", id);
                m.appendReplacement(sb, "[?]");
            }
        }
        m.appendTail(sb);
        return sb.toString();
    }
}

package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.service.handler.MedicalTermFilter;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang.StringUtils;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Description: 高亮工具类
 */
@Slf4j
public class HighLightUtils {
    /***
     * 修复es中缺失标点符号问题
     * 美化高亮 1 禁止停用词高亮 2 当存在较长的高亮时取出单个字符的高亮
     * @param highTarget 原文
     * @param highResult es检索后高亮
     * @param condition 检索条件
     * @param search 二次检索高亮显示
     * @return 修复后的摘要显示
     */
    public static String highLight(String highTarget, String highResult, Condition condition, String search) {
        Set<String> drugSet = new HashSet<>();
        Set<String> diseaseSet = new HashSet<>();
        
        JSONArray array = new JSONArray();
        if (condition != null) {
            List<Drug> drugs = condition.getDrugs();
            List<InterventionAndOutcome> interventions = condition.getInterventions();
            array.add(drugs);
            if (CollectionUtils.isNotEmpty(interventions)) {
                array.add(interventions);
            }
            
            for (int i = 0; i < array.size(); i++) {
                JSONArray innerArr = array.getJSONArray(i);
                if (CollectionUtils.isNotEmpty(innerArr)) {
                    for (int i1 = 0; i1 < innerArr.size(); i1++) {
                        JSONObject entity = innerArr.getJSONObject(i1);
                        JSONObject synonymMapObj = entity.getJSONObject("synonymMap");
                        Integer status = entity.getInteger("status");
                        if (Objects.nonNull(synonymMapObj)) {
                            Map<String, Set<String>> synonymMap = JSON.parseObject(JSON.toJSONString(synonymMapObj), new TypeReference<Map<String, Set<String>>>() {});
                            for (Map.Entry<String, Set<String>> entry : synonymMap.entrySet()) {
                                drugSet.addAll(entry.getValue());
                            }
                        } else {
                            if (status == 1) {
                                String word = entity.getString("word").toLowerCase();
                                drugSet.add(word);

                                String enWord = entity.getString("enWord");
                                if (StringUtils.isNotBlank(enWord)) {
                                    drugSet.add(enWord.toLowerCase());
                                    drugSet.add(enWord);
                                }

                                String zhWord = entity.getString("zhWord");
                                if (StringUtils.isNotBlank(zhWord)) {
                                    drugSet.add(zhWord.toLowerCase());
                                    drugSet.add(zhWord);
                                }

                                JSONArray enSynonym = entity.getJSONArray("enSynonym");
                                if (CollectionUtils.isNotEmpty(enSynonym)) {
                                    for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                        JSONObject enObj = enSynonym.getJSONObject(i2);
                                        String name = enObj.getString("name");
                                        Boolean checked = enObj.getBoolean("checked");
                                        if (checked) {
                                            drugSet.add(name.toLowerCase());
                                            drugSet.add(name);
                                        }
                                    }
                                }

                                JSONArray zhSynonym = entity.getJSONArray("zhSynonym");
                                if (CollectionUtils.isNotEmpty(zhSynonym)) {
                                    for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                        JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                        String name = jsonObject.getString("name");
                                        Boolean checked = jsonObject.getBoolean("checked");
                                        if (checked) {
                                            drugSet.add(name.toLowerCase());
                                            drugSet.add(name);
                                        }
                                    }
                                }

                                JSONArray otherSynonym = entity.getJSONArray("otherSynonym");
                                if (CollectionUtils.isNotEmpty(otherSynonym)) {
                                    for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                        JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                        String name = jsonObject.getString("name");
                                        Boolean checked = jsonObject.getBoolean("checked");
                                        if (checked) {
                                            drugSet.add(name.toLowerCase());
                                            drugSet.add(name);
                                        }
                                    }
                                }

                                //补充同义词
                                String expandSynonym = entity.getString("expandSynonym");
                                if (StringUtils.isNotBlank(expandSynonym)) {
                                    expandSynonym = expandSynonym.replaceAll("；", ";");
                                    String[] split = expandSynonym.split(";");
                                    for (String txt : split) {
                                        if (StringUtils.isNotBlank(txt)) {
                                            drugSet.add(txt.toLowerCase());
                                            drugSet.add(txt);
                                        }
                                    }
                                }

                                // 增加商品名
                                JSONArray commodityNames = entity.getJSONArray("commodityNames");
                                if (CollectionUtils.isNotEmpty(commodityNames)) {
                                    drugSet.addAll(commodityNames.stream().map(String::valueOf).distinct().collect(Collectors.toList()));
                                }

                                // 药品表中 五级同义词
                                JSONArray zhDrugNames = entity.getJSONArray("zhDrugNames");
                                if (CollectionUtils.isNotEmpty(zhDrugNames)) {
                                    drugSet.addAll(zhDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                                }
                                JSONArray enDrugNames = entity.getJSONArray("enDrugNames");
                                if (CollectionUtils.isNotEmpty(enDrugNames)) {
                                    drugSet.addAll(enDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                                }
                            }
                        }
                        drugSet = drugSet.stream().map(MedicalTermFilter::filterSemanticWords).filter(StrUtil::isNotBlank).collect(Collectors.toSet());
                    }
                }
            }
            
            JSONArray otherArray = new JSONArray();
            List<Disease> diseases = condition.getDiseases();
            if (CollectionUtils.isNotEmpty(diseases)) {
                otherArray.add(diseases);
            }
            List<InterventionAndOutcome> outcomes = condition.getOutcomes();
            if (CollectionUtils.isNotEmpty(outcomes)) {
                otherArray.add(outcomes);
            }
            for (int i = 0; i < otherArray.size(); i++) {
                JSONArray innerArr = otherArray.getJSONArray(i);
                if (CollectionUtils.isNotEmpty(innerArr)) {
                    for (int i1 = 0; i1 < innerArr.size(); i1++) {
                        JSONObject entity = innerArr.getJSONObject(i1);
                        JSONObject synonymMapObj = entity.getJSONObject("synonymMap");
                        Integer status = entity.getInteger("status");
                        if (Objects.nonNull(synonymMapObj)) {
                            Map<String, Set<String>> synonymMap = JSON.parseObject(JSON.toJSONString(synonymMapObj), new TypeReference<Map<String, Set<String>>>() {});
                            for (Map.Entry<String, Set<String>> entry : synonymMap.entrySet()) {
                                diseaseSet.addAll(entry.getValue());
                            }
                        } else {
                            if (status == 1) {
                                String word = entity.getString("word").toLowerCase();
                                diseaseSet.add(word);

                                String enWord = entity.getString("enWord");
                                if (StringUtils.isNotBlank(enWord)) {
                                    diseaseSet.add(enWord.toLowerCase());
                                    diseaseSet.add(enWord);
                                }

                                String zhWord = entity.getString("zhWord");
                                if (StringUtils.isNotBlank(zhWord)) {
                                    diseaseSet.add(zhWord.toLowerCase());
                                    diseaseSet.add(zhWord);
                                }

                                JSONArray enSynonym = entity.getJSONArray("enSynonym");
                                if (CollectionUtils.isNotEmpty(enSynonym)) {
                                    for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                        JSONObject enObj = enSynonym.getJSONObject(i2);
                                        String name = enObj.getString("name");
                                        Boolean checked = enObj.getBoolean("checked");
                                        if (checked) {
                                            diseaseSet.add(name.toLowerCase());
                                            diseaseSet.add(name);
                                        }
                                    }
                                }

                                JSONArray zhSynonym = entity.getJSONArray("zhSynonym");
                                if (CollectionUtils.isNotEmpty(zhSynonym)) {
                                    for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                        JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                        String name = jsonObject.getString("name");
                                        Boolean checked = jsonObject.getBoolean("checked");
                                        if (checked) {
                                            diseaseSet.add(name.toLowerCase());
                                            diseaseSet.add(name);
                                        }
                                    }
                                }

                                JSONArray otherSynonym = entity.getJSONArray("otherSynonym");
                                if (CollectionUtils.isNotEmpty(otherSynonym)) {
                                    for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                        JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                        String name = jsonObject.getString("name");
                                        Boolean checked = jsonObject.getBoolean("checked");
                                        if (checked) {
                                            diseaseSet.add(name.toLowerCase());
                                            diseaseSet.add(name);
                                        }
                                    }
                                }

                                //补充同义词
                                String expandSynonym = entity.getString("expandSynonym");
                                if (StringUtils.isNotBlank(expandSynonym)) {
                                    expandSynonym = expandSynonym.replaceAll("；", ";");
                                    String[] split = expandSynonym.split(";");
                                    for (String txt : split) {
                                        if (StringUtils.isNotBlank(txt)) {
                                            diseaseSet.add(txt.toLowerCase());
                                            diseaseSet.add(txt);
                                        }
                                    }
                                }

                                // 增加商品名
                                JSONArray commodityNames = entity.getJSONArray("commodityNames");
                                if (CollectionUtils.isNotEmpty(commodityNames)) {
                                    diseaseSet.addAll(commodityNames.stream().map(String::valueOf).distinct().collect(Collectors.toList()));
                                }

                                // 药品表中 五级同义词
                                JSONArray zhDrugNames = entity.getJSONArray("zhDrugNames");
                                if (CollectionUtils.isNotEmpty(zhDrugNames)) {
                                    diseaseSet.addAll(zhDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                                }
                                JSONArray enDrugNames = entity.getJSONArray("enDrugNames");
                                if (CollectionUtils.isNotEmpty(enDrugNames)) {
                                    diseaseSet.addAll(enDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                                }
                            }
                        }
                        diseaseSet = diseaseSet.stream().map(MedicalTermFilter::filterSemanticWords).filter(StrUtil::isNotBlank).collect(Collectors.toSet());
                    }
                }
            }
        }
        
        //正在获得全部需要高亮的数据
        highTarget = highTarget.replaceAll("<b>", "卍").replaceAll("</b>", "卐");
        Pattern pattern = Pattern.compile("卍.*?卐", Pattern.CASE_INSENSITIVE);
        Matcher matcher = pattern.matcher(highTarget);
        Set<String> set = new HashSet<>();
        while (matcher.find()) {
            String group = matcher.group();
            if (group.indexOf("卍") == group.lastIndexOf("卍") && group.indexOf("卐") == group.lastIndexOf("卐") && (group.length() != 1)) {
                set.add(group);
            }
        }
        
        // 修改后的高亮匹配逻辑
        for (String s : set) {
            s = s.replaceAll("卍", "");
            s = s.replaceAll("卐", "");
            String pre = "";
            String tag = "";

            // 精确匹配药品词汇
            boolean isDrugMatch = false;
            for (String drugTerm : drugSet) {
                // 检查drugTerm的所有词汇是否都在set中
                if (isAllTermWordsInHighlightSet(drugTerm, set)) {
                    if (isExactMatch(s, drugTerm)) {
                        pre = "<b>";
                        tag = "</b>";
                        isDrugMatch = true;
                        break;
                    }
                    if (isExactMatchIgnorePrepositions(s, drugTerm)) {
                        pre = "<b>";
                        tag = "</b>";
                        isDrugMatch = true;
                        break;
                    }
                    if (isPartOfTermIgnorePrepositions(s, drugTerm)) {
                        pre = "<b>";
                        tag = "</b>";
                        isDrugMatch = true;
                        break;
                    }
                }
            }

            // 只有不是药品匹配时才检查疾病匹配
            if (!isDrugMatch) {
                for (String diseaseTerm : diseaseSet) {
                    // 检查diseaseTerm的所有词汇是否都在set中
                    if (isAllTermWordsInHighlightSet(diseaseTerm, set)) {
                        if (isExactMatch(s, diseaseTerm)) {
                            pre = "<i>";
                            tag = "</i>";
                            break;
                        }
                        if (isExactMatchIgnorePrepositions(s, diseaseTerm)) {
                            pre = "<i>";
                            tag = "</i>";
                            break;
                        }
                        if (isPartOfTermIgnorePrepositions(s, diseaseTerm)) {
                            pre = "<i>";
                            tag = "</i>";
                            break;
                        }
                    }
                }
            }

            // 搜索词匹配有最高优先级
            if (StringUtils.isNotBlank(search)) {
                // 检查search的所有词汇是否都在set中
                if (isAllTermWordsInHighlightSet(search, set)) {
                    if (isExactMatch(s, search)) {
                        pre = "<strong>";
                        tag = "</strong>";
                    }
                    else if (isExactMatchIgnorePrepositions(s, search)) {
                        pre = "<strong>";
                        tag = "</strong>";
                    }
                    else if (isPartOfTermIgnorePrepositions(s, search)) {
                        pre = "<strong>";
                        tag = "</strong>";
                    }
                }
            }

            if (StringUtils.isNotBlank(pre)) {
                highResult = replaceExactWord(highResult, s, pre + s + tag);
            }
        }
        
        highResult = highResult.replaceAll("卍", "");
        highResult = highResult.replaceAll("卐", "");
        return highResult;
    }

    /**
     * 检查词典术语的所有词汇是否都在高亮集合中
     * @param term 词典术语（如："inflammatory bowel disease ulcerative colitis type"）
     * @param highlightSet 高亮集合（包含卍卐标记的字符串集合）
     * @return 如果术语的所有词汇都在高亮集合中则返回true
     */
    private static boolean isAllTermWordsInHighlightSet(String term, Set<String> highlightSet) {
        if (StringUtils.isBlank(term) || CollectionUtils.isEmpty(highlightSet)) {
            return false;
        }

        // 清理高亮集合，移除标记符号
        Set<String> cleanHighlightSet = new HashSet<>();
        for (String highlight : highlightSet) {
            String cleaned = highlight.replaceAll("卍", "").replaceAll("卐", "").toLowerCase().trim();
            if (StringUtils.isNotBlank(cleaned)) {
                cleanHighlightSet.add(cleaned);
            }
        }

        // 使用MedicalTermFilter过滤术语，去除介词等功能词
        String filteredTerm = MedicalTermFilter.filterSemanticWords(term.toLowerCase());
        String[] termWords = filteredTerm.trim().split("\\s+");

        // 检查术语的每个词是否都在高亮集合中
        for (String termWord : termWords) {
            if (StringUtils.isBlank(termWord)) {
                continue;
            }

            boolean wordFound = false;

            // 1. 直接匹配
            if (cleanHighlightSet.contains(termWord)) {
                wordFound = true;
            }

            // 2. 检查是否作为高亮片段的一部分存在
            if (!wordFound) {
                for (String highlight : cleanHighlightSet) {
                    // 使用单词边界确保精确匹配
                    if (highlight.matches(".*\\b" + Pattern.quote(termWord) + "\\b.*")) {
                        wordFound = true;
                        break;
                    }
                }
            }

            // 3. 如果当前词没有在高亮集合中找到，返回false
            if (!wordFound) {
                return false;
            }
        }

        return true;
    }

    /**
     * 检查高亮片段是否是搜索查询的一部分
     */
    private static boolean isPartOfSearchQuery(String highlightFragment, String searchQuery) {
        if (StringUtils.isBlank(highlightFragment) || StringUtils.isBlank(searchQuery)) {
            return false;
        }

        // 将搜索查询分词
        String[] searchWords = searchQuery.toLowerCase().trim().split("\\s+");
        String fragment = highlightFragment.toLowerCase().trim();

        // 检查片段是否是搜索词中的任意一个
        for (String searchWord : searchWords) {
            if (fragment.equals(searchWord)) {
                return true;
            }
        }

        // 检查片段是否是搜索短语的一部分
        String normalizedSearch = searchQuery.toLowerCase().replaceAll("\\s+", " ");
        String normalizedFragment = fragment.replaceAll("\\s+", " ");

        return normalizedSearch.contains(normalizedFragment);
    }

    /**
     * 忽略介词的精确匹配判断（不区分大小写）
     */
    private static boolean isExactMatchIgnorePrepositions(String text, String keyword) {
        if (StringUtils.isBlank(text) || StringUtils.isBlank(keyword)) {
            return false;
        }

        // 使用MedicalTermFilter过滤掉介词等功能词
        String filteredText = MedicalTermFilter.filterSemanticWords(text.toLowerCase());
        String filteredKeyword = MedicalTermFilter.filterSemanticWords(keyword.toLowerCase());

        return filteredText.equals(filteredKeyword);
    }

    /**
     * 检查高亮片段是否是某个词典词汇的一部分（忽略介词）
     */
    private static boolean isPartOfTermIgnorePrepositions(String highlightFragment, String dictionaryTerm) {
        if (StringUtils.isBlank(highlightFragment) || StringUtils.isBlank(dictionaryTerm)) {
            return false;
        }

        // 过滤掉介词等功能词
        String filteredFragment = MedicalTermFilter.filterSemanticWords(highlightFragment.toLowerCase());
        String filteredTerm = MedicalTermFilter.filterSemanticWords(dictionaryTerm.toLowerCase());

        // 检查词典术语是否包含这个片段的所有关键词
        String[] fragmentWords = filteredFragment.split("\\s+");

        // 所有片段中的词都必须在词典术语中
        for (String word : fragmentWords) {
            if (!filteredTerm.contains(word)) {
                return false;
            }
        }

        return true;
    }


    /**
     * 精确匹配判断（不区分大小写）
     */
    private static boolean isExactMatch(String text, String keyword) {
        if (StringUtils.isBlank(text) || StringUtils.isBlank(keyword)) {
            return false;
        }
        return text.equalsIgnoreCase(keyword);
    }

    /**
     * 精确替换单词，避免替换子字符串
     */
    private static String replaceExactWord(String text, String target, String replacement) {
        if (StringUtils.isBlank(text) || StringUtils.isBlank(target)) {
            return text;
        }

        // 使用正则表达式进行精确单词匹配和替换
        // \b 表示单词边界，确保只匹配完整单词
        String regex = Pattern.quote(target);
        String s = text.replaceAll(regex, replacement);
        return s;
    }

    /****
     * 修复缺失的标点并且高亮
     * @param data 数据
     * @param originalData 原始数据
     * @param stops 停用词
     * @return 处理后的数据
     */
    public static String repairContent(String data, String originalData, List<String> stops) {
        try {
            data = data.replaceAll("<b>", "卍").replaceAll("</b>", "卐");
            data = data.replaceAll("卐卍", "");
            data = data.replaceAll("卐 卍", " ");
            List<String> l = new ArrayList<>();
            int left = 0, right = 0;
            int maxLen = 0;
            while (right < data.length()) {
                if (data.charAt(right) == '卍') {
                    left = right;
                }
                if (data.charAt(right) == '卐') {
                    String substring = data.substring(left + 1, right);
                    if (!StrUtil.isNumeric(substring)) {
                        l.add(substring);
                    }
                }
                maxLen = Math.max(maxLen, right - left - 1);
                right++;
            }
            for (int i = 0; i < l.size(); i++) {
                if (l.get(i).length() == 1) {
                    continue;
                }
                boolean flag = true;
                for (int j = i + 1; j < l.size(); j++) {
                    if (l.get(j).contains(l.get(i))) {
                        flag = false;
                        break;
                    }
                }
                //停用词不给高亮
                if (stops.contains(l.get(i).toLowerCase())) {
                    continue;
                }
                if (flag) {
                    String escapedText = Pattern.quote(l.get(i));
                    if (maxLen > 1 && l.get(i).length() > 1) {
                        originalData = originalData.replaceAll(escapedText, "<b>" + l.get(i) + "</b>");
                    } else if (maxLen == 1) {
                        originalData = originalData.replaceAll(escapedText, "<b>" + l.get(i) + "</b>");
                    }
                }
            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return originalData;
    }
}


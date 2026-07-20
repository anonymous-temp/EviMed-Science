package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

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
        //获取药品+参比药物的集合
        Set<String> drugSet = new HashSet<>();
        //获取疾病+结局指标的集合
        Set<String> diseaseSet = new HashSet<>();
        JSONArray array = new JSONArray();
        if (condition != null) {
            List<Drug> drugs = condition.getDrugs();
            List<InterventionAndOutcome> interventions = condition.getInterventions();
            array.add(drugs);
            if (CollUtil.isNotEmpty(interventions)) {
                array.add(interventions);
            }
            for (int i = 0; i < array.size(); i++) {
                JSONArray innerArr = array.getJSONArray(i);
                if (CollUtil.isNotEmpty(innerArr)) {
                    for (int i1 = 0; i1 < innerArr.size(); i1++) {
                        JSONObject json = innerArr.getJSONObject(i1);
                        Integer status = json.getInteger("status");
                        if (status == 1) {
                            String word = json.getString("word").toLowerCase();
                            drugSet.add(word.toLowerCase());
                            drugSet.add(word);
                            
                            String enWord = json.getString("enWord");
                            if (StringUtils.isNotBlank(enWord)) {
                                drugSet.add(enWord.toLowerCase());
                            }
                            
                            JSONArray enSynonym = json.getJSONArray("enSynonym");
                            if (CollUtil.isNotEmpty(enSynonym)) {
                                for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                    JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                    String name = jsonObject.getString("name");
                                    Boolean checked = jsonObject.getBoolean("checked");
                                    if (checked) {
                                        drugSet.add(name);
                                    }
                                }
                            }
                            
                            String zhWord = json.getString("zhWord");
                            if (StringUtils.isNotBlank(zhWord)) {
                                drugSet.add(zhWord.toLowerCase());
                            }
                            
                            JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                            if (CollUtil.isNotEmpty(zhSynonym)) {
                                for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                    JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                    String name = jsonObject.getString("name");
                                    Boolean checked = jsonObject.getBoolean("checked");
                                    if (checked) {
                                        drugSet.add(name);
                                    }
                                }
                            }

                            JSONArray otherSynonym = json.getJSONArray("otherSynonym");
                            if (CollUtil.isNotEmpty(otherSynonym)){
                                for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                    JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                    String name = jsonObject.getString("name");
                                    Boolean checked = jsonObject.getBoolean("checked");
                                    if (checked) {
                                        drugSet.add(name);
                                    }
                                }
                            }
                            
                            //补充同义词
                            String expandSynonym = json.getString("expandSynonym");
                            if (StrUtil.isNotBlank(expandSynonym)) {
                                expandSynonym = expandSynonym.replaceAll("；", ";");
                                String[] split = expandSynonym.split(";");
                                for (String txt : split) {
                                    if (StringUtils.isNotBlank(txt)) {
                                        drugSet.add(txt.toLowerCase());
                                    }
                                }
                            }

                            // 增加商品名
                            JSONArray commodityNames = json.getJSONArray("commodityNames");
                            if (CollUtil.isNotEmpty(commodityNames)) {
                                List<String> collect = commodityNames.stream().map(String::valueOf).collect(Collectors.toList());
                                collect = collect.stream().distinct().collect(Collectors.toList());
                                drugSet.addAll(collect);
                            }

                            // 药品表中 五级同义词
                            JSONArray zhDrugNames = json.getJSONArray("zhDrugNames");
                            if (CollUtil.isNotEmpty(zhDrugNames)) {
                                drugSet.addAll(zhDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                            }
                            JSONArray enDrugNames = json.getJSONArray("enDrugNames");
                            if (CollUtil.isNotEmpty(enDrugNames)) {
                                drugSet.addAll(enDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                            }
                        }
                    }
                }
            }
            JSONArray otherArray = new JSONArray();
            List<Disease> diseases = condition.getDiseases();
            if (CollUtil.isNotEmpty(diseases)) {
                otherArray.add(diseases);
            }
            // 去定语之后的
            List<Disease> literatureWipeDiseases = condition.getLiteratureWipeDiseases();
            // 结局指标
            List<InterventionAndOutcome> outcomes = condition.getOutcomes();
            if (CollUtil.isNotEmpty(outcomes)) {
                otherArray.add(outcomes);
            }

            int wipeDiseaseSize = 0;
            
            for (int i = 0; i < otherArray.size(); i++) {
                JSONArray innerArr = otherArray.getJSONArray(i);
                if (CollUtil.isNotEmpty(innerArr)) {
                    for (int i1 = 0; i1 < innerArr.size(); i1++) {
                        JSONObject json = innerArr.getJSONObject(i1);
                        Integer status = json.getInteger("status");
                        if (status == 1) {
                            String word = json.getString("word").toLowerCase();
                            diseaseSet.add(word);
                            
                            String enWord = json.getString("enWord");
                            if (StringUtils.isNotBlank(enWord)) {
                                diseaseSet.add(enWord.toLowerCase());
                            }
                            
                            JSONArray enSynonym = json.getJSONArray("enSynonym");
                            if (CollUtil.isNotEmpty(enSynonym)) {
                                for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                    JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                    String name = jsonObject.getString("name");
                                    Boolean checked = jsonObject.getBoolean("checked");
                                    if (checked) {
                                        diseaseSet.add(name);
                                    }
                                }
                            }
                            
                            String zhWord = json.getString("zhWord");
                            if (StringUtils.isNotBlank(zhWord)) {
                                diseaseSet.add(zhWord.toLowerCase());
                            }
                            
                            JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                            if (CollUtil.isNotEmpty(zhSynonym)) {
                                for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                    JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                    String name = jsonObject.getString("name");
                                    Boolean checked = jsonObject.getBoolean("checked");
                                    if (checked) {
                                        diseaseSet.add(name);
                                    }
                                }
                            }

                            JSONArray otherSynonym = json.getJSONArray("otherSynonym");
                            if (CollUtil.isNotEmpty(otherSynonym)){
                                for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                    JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                    String name = jsonObject.getString("name");
                                    Boolean checked = jsonObject.getBoolean("checked");
                                    if (checked) {
                                        diseaseSet.add(name);
                                    }
                                }
                            }
                            
                            //补充同义词
                            String expandSynonym = json.getString("expandSynonym");
                            if (StrUtil.isNotBlank(expandSynonym)) {
                                expandSynonym = expandSynonym.replaceAll("；", ";");
                                String[] split = expandSynonym.split(";");
                                for (String txt : split) {
                                    if (StringUtils.isNotBlank(txt)) {
                                        diseaseSet.add(txt.toLowerCase());
                                    }
                                }
                            }
                            
                            try {
                                Disease disease = literatureWipeDiseases.get(wipeDiseaseSize++);

                                String word_ = disease.getWord();
                                diseaseSet.add(word_.toLowerCase());
                                diseaseSet.add(word_);

                                String enWord_ = disease.getEnWord();
                                if (StringUtils.isNotBlank(enWord_)){
                                    diseaseSet.add(enWord_.toLowerCase());
                                    diseaseSet.add(enWord_);
                                }

                                List<WordStatus> enSynonym_ = disease.getEnSynonym();
                                if (CollUtil.isNotEmpty(enSynonym_)){
                                    for (WordStatus wordStatus : enSynonym_) {
                                        String name = wordStatus.getName();
                                        Boolean checked = wordStatus.getChecked();
                                        if (checked) {
                                            diseaseSet.add(name.toLowerCase());
                                            diseaseSet.add(name);
                                        }
                                    }
                                }

                                String zhWord_ = disease.getZhWord();
                                if (StringUtils.isNotBlank(zhWord_)){
                                    diseaseSet.add(zhWord_.toLowerCase());
                                    diseaseSet.add(zhWord_);
                                }

                                List<WordStatus> zhSynonym_ = disease.getZhSynonym();
                                if (CollUtil.isNotEmpty(zhSynonym_)){
                                    for (WordStatus wordStatus : zhSynonym_) {
                                        String name = wordStatus.getName();
                                        Boolean checked = wordStatus.getChecked();
                                        if (checked) {
                                            diseaseSet.add(name.toLowerCase());
                                            diseaseSet.add(name);
                                        }
                                    }
                                }

                                List<WordStatus> otherSynonym_ = disease.getOtherSynonym();
                                if (CollUtil.isNotEmpty(otherSynonym_)){
                                    for (WordStatus wordStatus : otherSynonym_) {
                                        String name = wordStatus.getName();
                                        Boolean checked = wordStatus.getChecked();
                                        if (checked) {
                                            diseaseSet.add(name.toLowerCase());
                                            diseaseSet.add(name);
                                        }
                                    }
                                }
                            } catch (Exception e) {
                                log.info("结局指标没有去定语!!!");
                            }
                        }
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
        for (String s : set) {
            s = s.replaceAll("卍", "");
            s = s.replaceAll("卐", "");
            String pre = "";
            String tag = "";
            for (String s1 : drugSet) {
                if (s1.length() == 1) {
                    continue;
                }
                if (s.toLowerCase().contains(s1.toLowerCase())) {
                    pre = "<b>";
                    tag = "</b>";
                    break;
                }
            }
            for (String s1 : diseaseSet) {
                if (s1.length() == 1) {
                    continue;
                }
                if (s.toLowerCase().contains(s1.toLowerCase())) {
                    pre = "<i>";
                    tag = "</i>";
                    break;
                }
            }
            if (StringUtils.isNotBlank(search)) {
                if (s.toLowerCase().contains(search.toLowerCase())) {
                    pre = "<strong>";
                    tag = "</strong>";
                }
            }
            if (StringUtils.isNotBlank(pre)) {
                highResult = highResult.replaceAll(s, pre + s + tag);
            }
        }
        highResult = highResult.replaceAll("卍", "");
        highResult = highResult.replaceAll("卐", "");
        return highResult;
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
            
            l = removeContainedStrings(l);
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
                    if (maxLen > 1 && l.get(i).length() > 1) {
                        originalData = originalData.replaceAll(l.get(i), "<b>" + l.get(i) + "</b>");
                    } else if (maxLen == 1) {
                        originalData = originalData.replaceAll(l.get(i), "<b>" + l.get(i) + "</b>");
                    }
                }
            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return originalData;
    }

    public static List<String> removeContainedStrings(List<String> needRemoveList) {
        Set<String> result = new HashSet<>(needRemoveList);

        for (String s1 : needRemoveList) {
            for (String s2 : needRemoveList) {
                if (!s1.equals(s2) && s2.contains(s1)) {
                    result.remove(s1);
                    break;
                }
            }
        }

        return new ArrayList<>(result);
    }
}

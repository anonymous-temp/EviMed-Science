package com.sentum.drugsafe.utils;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONArray;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
    public static String highLight(String highTarget, String highResult, Set condition, String search) {
        //获取药品+参比药物的集合
        Set<String> drugSet = condition;
        //获取疾病+结局指标的集合
        JSONArray array = new JSONArray();


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
}

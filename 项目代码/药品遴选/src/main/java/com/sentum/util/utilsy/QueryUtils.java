package com.sentum.util.utilsy;

import cn.hutool.core.collection.CollUtil;
import com.sentum.opcode.SearchFormula;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.*;

import java.util.*;
import java.util.regex.Pattern;

/**
 * 拼接检索条件的工具类
 * @author zgm
 */
public class QueryUtils {

    public static StringBuilder montageForCustomizeName(StringBuilder query, List<String> inner, String type, String joinType) {
        if (inner == null || inner.isEmpty()) {
            return query;
        }

        // 预处理 type 分割，避免重复分割
        String[] typeArray = StringUtils.isNotBlank(type) ? type.split(",") : new String[0];


        if ("NOT".equals(joinType)) {
            for (int i = 0; i < inner.size(); i++) {
                // 统一处理括号移除
                String cleanedTerm = inner.get(i)
                        .replaceAll("[\\(\\)（）]", ""); // 使用正则一次性移除所有括号

                // 构建当前项的查询条件
                if (typeArray.length > 0) {
                    for (String s : typeArray) {
                        query.append("(").append(cleanedTerm).append("[").append(s).append("]").append(")").append(" ").append(joinType).append(" ");
                    }
                } else {
                    query.append("(").append(cleanedTerm).append(")").append(" ").append(joinType).append(" ");
                }
            }
            if (query.toString().endsWith(" "+joinType+" ")) {
                query.delete(query.length() - joinType.length() - 2, query.length());
            }
            return query;
        }    
        
        query.append("(");
       
        for (int i = 0; i < inner.size(); i++) {
            // 统一处理括号移除
            String cleanedTerm = inner.get(i)
                    .replaceAll("[\\(\\)（）]", ""); // 使用正则一次性移除所有括号

            // 构建当前项的查询条件
            if (typeArray.length > 0) {
                for (int j = 0; j < typeArray.length; j++) {
                    query.append(cleanedTerm).append("[").append(typeArray[j]).append("]");
                    if (j < typeArray.length - 1) {
                        query.append(" ").append(joinType).append(" ");
                    }
                }
            } else {
                query.append(cleanedTerm);
            }

            // 添加 OR 连接符（除了最后一个元素）
            if (i < inner.size() - 1) {
                query.append(" ").append(joinType).append(" ");
            }
        }

        query.append(")");
        return query;
    }


    public static void montage(StringBuilder query, Set<String> set) {
        query.append("(");
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s);
        query.append(")");
    }


    public static BoolQueryBuilder createGuideQuery(String keyword, Set<String> synonym) {
        if (synonym == null) {
            synonym = new java.util.HashSet<>();
        }
        if (keyword != null && !keyword.isEmpty()) {
            synonym.add(keyword);
        }

        List<String> zhList = new ArrayList<>();
        List<String> enList = new ArrayList<>();
        // 正则1：用于匹配至少一个汉字（任何属于 Han Script 的字符）
        Pattern chinesePattern = Pattern.compile("\\p{IsHan}");
        // 正则2：用于判断字符串是否为纯英文（仅包含 ASCII 字符） 
        Pattern englishPattern = Pattern.compile("^[\\u0000-\\u007F]+$");
        for (String str : synonym) {
            if (str == null) {
                continue;
            }
            if (chinesePattern.matcher(str).find()) {
                zhList.add(str);
            } else {
                // 检查是否全为 ASCII 字符
                if (englishPattern.matcher(str).matches()) {
                    enList.add(str);
                }
            }
        }

        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();

        StringBuilder query = new StringBuilder();

        zhList.addAll(enList);
        if (CollUtil.isNotEmpty(zhList)) {
            query.append("(");
            for (String string : zhList) {
                //去除检索条件中的括号
                String s = string.replaceAll("\\(", "").replaceAll("\\)", "");
                s = s.replaceAll("（", "").replaceAll("）", "");
                query.append(s).append(" OR ");
            }
            String s = zhList.get(zhList.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s);
            query.append(")");

            String formula = new SearchFormula().execute(query.toString(), 2, 1, 0).toString();
            boolQuery.must().add(QueryBuilders.wrapperQuery(formula));
        }
        return boolQuery;
    }

    public static BoolQueryBuilder createPaperQueryBySynonym(String keyword, Set<String> synonym){
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();

        synonym.add(keyword);

        List<String> zhList = new ArrayList<>();
        List<String> enList = new ArrayList<>();
        // 正则1：用于匹配至少一个汉字（任何属于 Han Script 的字符）
        Pattern chinesePattern = Pattern.compile("\\p{IsHan}");
        // 正则2：用于判断字符串是否为纯英文（仅包含 ASCII 字符） 
        Pattern englishPattern = Pattern.compile("^[\\u0000-\\u007F]+$");
        for (String str : synonym) {
            if (chinesePattern.matcher(str).find()) {
                zhList.add(str);
            } else {
                if (englishPattern.matcher(str).matches()) {
                    enList.add(str);
                }
            }
        }

        BoolQueryBuilder zhBoolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder enBoolQueryBuilder = new BoolQueryBuilder();
        if (CollUtil.isNotEmpty(zhList)) {
            for (String zh : zhList) {
                MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(zh, "title", "summary", "tldr", "result", "conclusion");
                multiMatchQueryBuilder.field("title", 100f);
                multiMatchQueryBuilder.operator(Operator.AND);
                multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                multiMatchQueryBuilder.analyzer("standard");
                zhBoolQueryBuilder.should().add(multiMatchQueryBuilder);
            }
            boolQuery.should().add(zhBoolQueryBuilder);
        }

        if (CollUtil.isNotEmpty(enList)) {
            for (String en : enList) {
                MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(en, "title", "summary", "tldr", "result", "conclusion");
                multiMatchQueryBuilder.field("title", 100f);
                multiMatchQueryBuilder.operator(Operator.AND);
//                multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                multiMatchQueryBuilder.analyzer("standard");
                enBoolQueryBuilder.should().add(multiMatchQueryBuilder);
            }
            boolQuery.should().add(enBoolQueryBuilder);
        }
        return boolQuery;
    }
}
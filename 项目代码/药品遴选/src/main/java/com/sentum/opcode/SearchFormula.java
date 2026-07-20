package com.sentum.opcode;


import cn.hutool.core.util.StrUtil;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;

import java.util.*;

@Slf4j
public class SearchFormula {

    public static void main(String[] args) {
        String formula = "((((a OR b) OR h) AND (c OR d)) OR e) AND f";
        SearchFormula searchFormula = new SearchFormula();
        Map<String, String> preMap = new HashMap<>();
        searchFormula.parse(formula, preMap, 0);
        searchFormula.simple(preMap);
        Set<Map.Entry<String, String>> entries = preMap.entrySet();
        for (Map.Entry<String, String> entry : entries) {
            String key = entry.getKey();
            String value = entry.getValue();
            System.out.println(key + "---" + value);
            System.out.println("----------------------------");
        }
    }

    private String parse(String formulaStr, Map<String, String> preMap, Integer index) {
        formulaStr = formulaStr.replace((char) 12288, ' ');
        LinkedList<Character> stack = new LinkedList<>();
        //int index = 0;
        for (int i = 0; i < formulaStr.length(); i++) {
            if (formulaStr.charAt(i) == ')' && !stack.isEmpty()) {
                StringBuilder sb = new StringBuilder();
                while (!stack.isEmpty()) {
                    char c = stack.pop();
                    if (c != '(') {
                        sb.append(c);
                    } else {
                        break;
                    }
                }
                String val = sb.reverse().toString();
                String key = "卍" + (index++);
                preMap.put(key.trim(), val.trim());
                char[] chars = key.toCharArray();
                for (char ch : chars) {
                    stack.push(ch);
                }
            } else {
                stack.push(formulaStr.charAt(i));
            }
        }

        StringBuilder op = new StringBuilder();
        while (!stack.isEmpty()) {
            op.append(stack.pop());
        }
        return op.reverse().toString();
    }

    //简化检索式层数
    private void simple(Map<String, String> preMap){
        for(Map.Entry<String, String> entry : preMap.entrySet()){
            String ops = entry.getValue();
            String spl = getSpl(ops);
            String[] arr = ops.split(spl);
            StringBuilder sb = new StringBuilder();
            for(String str : arr){
                if(preMap.get(str) != null && spl.equals(getSpl(preMap.get(str)))){
                    sb.append(preMap.get(str)).append(spl);
                }else {
                    sb.append(str).append(spl);
                }
            }
            preMap.put(entry.getKey(), sb.substring(0, sb.length() - spl.length()));
        }
    }

    private String getSpl(String ops){
        String spl;
        if (ops.contains(" OR ")) {
            spl = " OR ";
        } else if (ops.contains(" NOT ")) {
            spl = " NOT ";
        } else{
            spl = " AND ";
        }
        return spl;
    }

    public BoolQueryBuilder execute(String formulaStr, int type, int isPhrase, int level) {
        formulaStr = formulaStr.replaceAll("（","(");
        formulaStr = formulaStr.replaceAll("）",")");
        log.info("formula:{}",formulaStr);
        log.info("type:{}",type);
        Map<String, String> preMap = new LinkedHashMap<>();
        String ops = this.parse(formulaStr, preMap, 0);
        log.info("检索式为：{}", ops);
        int cnt = (ops.contains(" AND ") ? 1 : 0) + (ops.contains(" OR ") ? 1 : 0) + (ops.contains(" NOT ") ? 1 : 0);
        while (cnt > 1){
            ops = this.insertBracket(ops);
            int index = 0;
            Set<String> set = preMap.keySet();
            for (String s : set) {
                int anInt = Integer.parseInt(s.replaceAll("卍", ""));
                if (anInt > index){
                    index = anInt;
                }
            }
            ops = this.parse(ops, preMap, index + 1);
            log.info("添加括号后的检索式为：{}", ops);
            cnt = (ops.contains(" AND ") ? 1 : 0) + (ops.contains(" OR ") ? 1 : 0) + (ops.contains(" NOT ") ? 1 : 0);
        }
        simple(preMap);
        return dfs(ops, preMap, type, isPhrase, level);
    }

    /**
     * 给检索式添加一次括号
     * @param ops 检索式
     */
    private String insertBracket(String ops) {
        int num = 0;
        int index = 0;
        for (int i = 0; i < ops.length(); i++) {
            if (ops.charAt(i) == ' '){
                num ++;
                if (num == 3) {
                    index = i;
                    break;
                }
            }
        }
        StringBuilder builder = new StringBuilder(ops);
        builder.insert(0, "(");
        builder.insert(index + 1, ")");
        return builder.toString();
    }


    private BoolQueryBuilder dfs(String ops, Map<String, String> preMap, int type, int isPhrase, int level) {
        int cnt = (ops.contains(" AND ") ? 1 : 0) + (ops.contains(" OR ") ? 1 : 0) + (ops.contains(" NOT ") ? 1 : 0);
        if (cnt > 1) {
            //包含多种检索关键词，开始处理（待定）
            throw new RuntimeException("检索式格式错误");
        }
        
        String spl;
        if (ops.contains(" OR ")) {
            spl = " OR ";
        } else if (ops.contains(" NOT ")) {
            spl = " NOT ";
        } else {
            spl = " AND ";
        }
        
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        if (!ops.contains("卍")) {
            if (" AND ".equals(spl)) {
                boolQueryBuilder.must(AND.execute(ops, type, isPhrase, level));
            } else if (" NOT ".equals(spl)) {
                boolQueryBuilder.must(NOT.execute(ops, type, isPhrase, level));
            } else {
                boolQueryBuilder.should().add(OR.execute(ops, type, isPhrase, level));
            }
        } else {
            String[] array = ops.split(spl);
            for (int i = 0; i < array.length; i++) {
                String baseOps = array[i];
                if (baseOps.contains("卍")) {
                    String realOps = preMap.get(baseOps.trim());
                    if (StrUtil.isBlank(realOps)) {
                        continue;
                    }
                    if (StrUtil.isNotBlank(realOps)) {
                        BoolQueryBuilder ret = dfs(realOps, preMap, type, isPhrase, level);
                        if (" AND ".equals(spl)) {
                            boolQueryBuilder.must().add(ret);
                        } else if (" NOT ".equals(spl) && i > 0) {
                            boolQueryBuilder.mustNot(ret);
                        } else {
                            boolQueryBuilder.should().add(ret);
                        }
                    }
                } else {
                    if (" AND ".equals(spl)) {
                        boolQueryBuilder.must(AND.execute(baseOps, type, isPhrase, level));
                    } else if (" NOT ".equals(spl)) {
                        boolQueryBuilder.must(NOT.execute(baseOps, type, isPhrase, level));
                    } else {
                        boolQueryBuilder.should().add(OR.execute(baseOps, type, isPhrase, level));
                    }
                }
            }
        }
        return boolQueryBuilder;
    }
}

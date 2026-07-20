package com.sentum.evidencecomprehensive.opcode;


import cn.hutool.core.util.StrUtil;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;

import java.util.*;

@Slf4j
public class SearchFormula {

    public static void main(String[] args) {
        //String formula = "(双氯芬酸[标题] OR 双氯芬酸[摘要] OR 双氯芬酸[关键词] OR Diclofenac[标题] OR Diclofenac[摘要] OR Diclofenac[关键词]) AND (高血压[标题] OR 高血压[摘要] OR 高血压[关键词] OR hypertension[标题] OR hypertension[摘要] OR hypertension[关键词] OR high blood pressure[标题] OR high blood pressure[摘要] OR high blood pressure[关键词] OR hypertensive[标题] OR hypertensive[摘要] OR hypertensive[关键词])";
        String formula = "((((a OR b) OR h) AND (c OR d)) OR e) AND f";
        //String formula = "A OR B OR C";
        //String formula = "(氯吡格雷[标题] OR Clopidogrel[标题] OR 氯吡格雷[摘要] OR Clopidogrel[摘要]) AND (钙通道阻滞剂[标题] OR CCB[标题] OR Calcium Channel Blockers[标题] OR 维拉帕米[标题] OR 异搏定[标题] OR Verapamil[标题] OR 地尔硫卓[标题] OR 地尔硫䓬[标题] OR 地尔硫[标题] OR 硫氮卓酮[标题] OR 硫氮酮[标题] OR 恬尔心[标题] OR 合心爽[标题] OR Diltiazem[标题] OR 氨氯地平[标题] OR 络活喜[标题] OR Amlodipine[标题] OR 非洛地平[标题] OR Felodipine[标题] OR 硝苯地平[标题] OR 硝苯吡啶[标题] OR 心痛定[标题] OR 利心平[标题] OR 硝苯啶[标题] OR Nifedipine[标题] OR 钙通道阻滞剂[摘要] OR CCB[摘要] OR Calcium Channel Blockers[摘要] OR 维拉帕米[摘要] OR 异搏定[摘要] OR Verapamil[摘要] OR 地尔硫卓[摘要] OR 地尔硫䓬[摘要] OR 地尔硫[摘要] OR 硫氮卓酮[摘要] OR 硫氮酮[摘要] OR 恬尔心[摘要] OR 合心爽[摘要] OR Diltiazem[摘要] OR 氨氯地平[摘要] OR 络活喜[摘要] OR Amlodipine[摘要] OR 非洛地平[摘要] OR Felodipine[摘要] OR 硝苯地平[摘要] OR 硝苯吡啶[摘要] OR 心痛定[摘要] OR 利心平[摘要] OR 硝苯啶[摘要] OR Nifedipine[摘要])";
        //SearchFormuler searchFormulaEngine = new SearchFormuler(true);
        //searchFormulaEngine.execute(formula);
        //String formula = "((a1 OR a2 OR a3 OR a4) NOT (b1 OR b2 OR b3 OR b4)) AND (c1 OR c2 OR c3 OR c4) AND (d1 OR d2 OR d3 OR d4) AND (e1 OR e2 OR e3 OR e4)";
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
            if (formulaStr.charAt(i) == ')' && stack.size() > 0) {
                StringBuilder sb = new StringBuilder();
                while (stack.size() > 0) {
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
        while (stack.size() > 0) {
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

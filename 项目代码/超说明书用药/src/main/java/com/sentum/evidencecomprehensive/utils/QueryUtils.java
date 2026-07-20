package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.map.MapUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.sentum.evidencecomprehensive.opcode.SearchFormula;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.InterventionAndOutcome;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;

import java.util.*;
import java.util.stream.Collectors;

/**
 * 拼接检索条件的工具类
 *
 * @author zgm
 */
public class QueryUtils {

    private static final Logger LOG = LoggerFactory.getLogger(QueryUtils.class);

    /**
     * 
     * @param array 检索词
     * @param operateList 保留检索词 输入词word
     * @param map 输入词word 和 所有同义词 关系map
     * @param modeType 检索内容类型 1 文献 2 指南 3 临床试验 4 说明书 5 hta 6 cde
     */
    private static void extracted(JSONArray array, List<String> operateList, Map<String, Set<String>> map, int modeType) {
        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollectionUtils.isNotEmpty(innerArr)){
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject entity = innerArr.getJSONObject(i1);
                    JSONObject synonymMapObj = entity.getJSONObject("synonymMap");
                    Integer status = entity.getInteger("status");
                    if (Objects.nonNull(synonymMapObj)) {
                        Map<String, Set<String>> synonymMap = JSON.parseObject(JSON.toJSONString(synonymMapObj), new TypeReference<Map<String, Set<String>>>() {});
                        int size = synonymMap.size();
                        int count = 0;
                        for (Map.Entry<String, Set<String>> entry : synonymMap.entrySet()) {
                            map.put(entry.getKey(), entry.getValue());
                            operateList.add(entry.getKey());
                            ++count;
                            if (count != size) {
                                operateList.add("@OR@");
                            }
                        }
                    } else {
                        if (status == 1){
                            Set<String> set = new HashSet<>();

                            String word = entity.getString("word").toLowerCase();
                            set.add(word);
                            operateList.add(word);

                            String enWord = entity.getString("enWord");
                            if (StringUtils.isNotBlank(enWord)){
                                set.add(enWord.toLowerCase());
                                set.add(enWord);
                            }

                            String zhWord = entity.getString("zhWord");
                            if (StringUtils.isNotBlank(zhWord)){
                                set.add(zhWord.toLowerCase());
                                set.add(zhWord);
                            }

                            if (modeType == 1 || modeType == 2 || modeType == 3) {
                                JSONArray enSynonym = entity.getJSONArray("enSynonym");
                                if (CollectionUtils.isNotEmpty(enSynonym)){
                                    for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                        JSONObject enObj = enSynonym.getJSONObject(i2);
                                        String name = enObj.getString("name");
                                        Boolean checked = enObj.getBoolean("checked");
                                        if (checked) {
                                            set.add(name.toLowerCase());
                                            set.add(name);
                                        }
                                    }
                                }

                                JSONArray zhSynonym = entity.getJSONArray("zhSynonym");
                                if (CollectionUtils.isNotEmpty(zhSynonym)){
                                    for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                        JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                        String name = jsonObject.getString("name");
                                        Boolean checked = jsonObject.getBoolean("checked");
                                        if (checked) {
                                            set.add(name.toLowerCase());
                                            set.add(name);
                                        }
                                    }
                                }

                                JSONArray otherSynonym = entity.getJSONArray("otherSynonym");
                                if (CollectionUtils.isNotEmpty(otherSynonym)){
                                    for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                        JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                        String name = jsonObject.getString("name");
                                        Boolean checked = jsonObject.getBoolean("checked");
                                        if (checked) {
                                            set.add(name.toLowerCase());
                                            set.add(name);
                                        }
                                    }
                                }
                            }

                            //补充同义词
                            String expandSynonym = entity.getString("expandSynonym");
                            if (StringUtils.isNotBlank(expandSynonym)) {
                                expandSynonym = expandSynonym.replaceAll("；", ";");
                                String[] split = expandSynonym.split(";");
                                for (String txt : split) {
                                    if(StringUtils.isNotBlank(txt)) {
                                        set.add(txt.toLowerCase());
                                        set.add(txt);
                                    }
                                }
                            }

                            // 增加商品名
                            JSONArray commodityNames = entity.getJSONArray("commodityNames");
                            if (CollectionUtils.isNotEmpty(commodityNames)) {
                                set.addAll(commodityNames.stream().map(String::valueOf).distinct().collect(Collectors.toList()));
                            }

                            // 药品表中 五级同义词
                            JSONArray zhDrugNames = entity.getJSONArray("zhDrugNames");
                            if (CollectionUtils.isNotEmpty(zhDrugNames)) {
                                set.addAll(zhDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                            }
                            JSONArray enDrugNames = entity.getJSONArray("enDrugNames");
                            if (CollectionUtils.isNotEmpty(enDrugNames)) {
                                set.addAll(enDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                            }

                            map.put(word, set);
                        } else {
                            if (status == 2){
                                //与
                                operateList.add("@AND@");
                            }else {
                                //非
                                operateList.add("@NOT@");
                            }
                        }
                    }            
                }
            }
            if (array.size() > 1 && i != array.size() - 1) {
                operateList.add("@OR@");
            }
        }
    }

    private static void extracted(JSONArray array, List<String> operateList, Map<String, Set<String>> map, List<Disease> diseases, List<Integer> indices) {
        // 确保 indices 数量与 diseases 数量一致
        if (indices == null || indices.size() != diseases.stream().filter(o -> o.getStatus() == 1).count()) {
            throw new IllegalArgumentException("Indices size must match diseases size.");
        }
        
        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollectionUtils.isNotEmpty(innerArr)){
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject entity = innerArr.getJSONObject(i1);
                    String word = entity.getString("word");
                    Integer status = entity.getInteger("status");
                    if (status == 1) {
                        JSONArray deconsWords = entity.getJSONArray("deconsWords");

                        if (CollectionUtils.isNotEmpty(deconsWords)) {
                            Disease disease = diseases.get(i1);
                            Map<String, Set<String>> synonymMap = disease.getSynonymMap();

                            if (MapUtil.isNotEmpty(synonymMap)) {
                                // ✅ 按字符长度从长到短排序
                                List<String> sortedKeys = new ArrayList<>(synonymMap.keySet());
                                // 先移除 word
                                sortedKeys.remove(word);
                                // 按长度排序剩余的
                                sortedKeys.sort((a, b) -> Integer.compare(b.length(), a.length()));
                                // 将 word 插入到第一位
                                sortedKeys.add(0, word);

                                // ✅ 根据组合中当前疾病对应的索引取 key
                                int index = indices.get(i1) % sortedKeys.size();
                                String key = sortedKeys.get(index);
                                Set<String> set = new HashSet<>();

                                if (!key.equals(word)) {
                                    set = synonymMap.get(key);
                                } else {
                                    set.add(word);
                                    operateList.add(word);

                                    String enWord = entity.getString("enWord");
                                    if (StringUtils.isNotBlank(enWord)){
                                        set.add(enWord.toLowerCase());
                                        set.add(enWord);
                                    }

                                    String zhWord = entity.getString("zhWord");
                                    if (StringUtils.isNotBlank(zhWord)){
                                        set.add(zhWord.toLowerCase());
                                        set.add(zhWord);
                                    }

                                    JSONArray enSynonym = entity.getJSONArray("enSynonym");
                                    if (CollectionUtils.isNotEmpty(enSynonym)){
                                        for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                            JSONObject enObj = enSynonym.getJSONObject(i2);
                                            String name = enObj.getString("name");
                                            Boolean checked = enObj.getBoolean("checked");
                                            if (checked) {
                                                set.add(name.toLowerCase());
                                                set.add(name);
                                            }
                                        }
                                    }

                                    JSONArray zhSynonym = entity.getJSONArray("zhSynonym");
                                    if (CollectionUtils.isNotEmpty(zhSynonym)){
                                        for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                            JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                            String name = jsonObject.getString("name");
                                            Boolean checked = jsonObject.getBoolean("checked");
                                            if (checked) {
                                                set.add(name.toLowerCase());
                                                set.add(name);
                                            }
                                        }
                                    }

                                    JSONArray otherSynonym = entity.getJSONArray("otherSynonym");
                                    if (CollectionUtils.isNotEmpty(otherSynonym)){
                                        for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                            JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                            String name = jsonObject.getString("name");
                                            Boolean checked = jsonObject.getBoolean("checked");
                                            if (checked) {
                                                set.add(name.toLowerCase());
                                                set.add(name);
                                            }
                                        }
                                    }

                                    //补充同义词
                                    String expandSynonym = entity.getString("expandSynonym");
                                    if (StringUtils.isNotBlank(expandSynonym)) {
                                        expandSynonym = expandSynonym.replaceAll("；", ";");
                                        String[] split = expandSynonym.split(";");
                                        for (String txt : split) {
                                            if(StringUtils.isNotBlank(txt)) {
                                                set.add(txt.toLowerCase());
                                                set.add(txt);
                                            }
                                        }
                                    }                                 
                                    
                                    // 增加商品名
                                    JSONArray commodityNames = entity.getJSONArray("commodityNames");
                                    if (CollectionUtils.isNotEmpty(commodityNames)) {
                                        set.addAll(commodityNames.stream().map(String::valueOf).distinct().collect(Collectors.toList()));
                                    }

                                    // 药品表中 五级同义词
                                    JSONArray zhDrugNames = entity.getJSONArray("zhDrugNames");
                                    if (CollectionUtils.isNotEmpty(zhDrugNames)) {
                                        set.addAll(zhDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                                    }
                                    JSONArray enDrugNames = entity.getJSONArray("enDrugNames");
                                    if (CollectionUtils.isNotEmpty(enDrugNames)) {
                                        set.addAll(enDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                                    }
                                }       
                                map.put(key, set);
                                operateList.add(key);
                            }
                        }
                    }                
                }

                if (array.size() > 1 && i != array.size() - 1) {
                    operateList.add("@OR@");
                }
            }
        }
    }

    /**
     * 
     * @param type 控制 使用哪种检索式
     * @param operateList  输入词word
     * @param map 输入词word 和 同义词 map
     * @param query  es 使用query
     * @param modeType 检索内容类型 1 文献 2 指南 3 临床试验 4 说明书 5 hta 6 cde
     */
    private static void assemble(Integer type, List<String> operateList, Map<String, Set<String>> map, StringBuilder query, int modeType, int drugOrDisease, int rangeType) {
        for (int i = 0; i < operateList.size(); i++) { 
            String wordOrOperate = operateList.get(i);
            if (i == 0){
                extracted(type, map, query, modeType, drugOrDisease, rangeType, wordOrOperate);
                continue;
            }
            if ("@AND@".equals(wordOrOperate)) {
                String word = operateList.get(i + 1);
                query.append(" AND ");
                extracted(type, map, query, modeType, drugOrDisease, rangeType, word);
                i++;
            } else if ("@NOT@".equals(wordOrOperate)) {
                String word = operateList.get(i + 1);
                query.append(" NOT ");
                extracted(type, map, query, modeType, drugOrDisease, rangeType, word);
                i++;
            } else if ("@OR@".equals(wordOrOperate)) {
                String word = operateList.get(i + 1);
                query.append(" OR ");
                extracted(type, map, query, modeType, drugOrDisease, rangeType, word);
                i++;
            }
        }
    }

    private static void assembleTest(Integer type, List<String> operateList, Map<String, Set<String>> map, StringBuilder query, int modeType, int drugOrDisease, int rangeType) {
        for (int i = 0; i < operateList.size(); i++) {
            String wordOrOperate = operateList.get(i);

            if (i == 0) {
                // 第一个元素，检查是否需要作为整体处理
                if (hasAndOperator(operateList)) {
                    // 如果列表中有AND操作符，找到第一个AND之前的所有元素作为整体
                    int firstAndIndex = findFirstAndIndex(operateList);
                    if (firstAndIndex > 0) {
                        // 处理第一个AND之前的整体
                        processGroup(type, map, query, modeType, drugOrDisease, rangeType, operateList, 0, firstAndIndex - 1);
                        i = firstAndIndex - 1; // 跳到AND操作符前
                    } else {
                        // 第一个就是AND，正常处理
                        extracted(type, map, query, modeType, drugOrDisease, rangeType, wordOrOperate);
                    }
                } else {
                    // 没有AND操作符，整个列表作为一个整体
                    processGroup(type, map, query, modeType, drugOrDisease, rangeType, operateList, 0, operateList.size() - 1);
                    break; // 处理完毕，退出循环
                }
                continue;
            }

            if ("@AND@".equals(wordOrOperate)) {
                query.append(" AND ");

                // 找到下一个AND的位置，或者到列表结束
                int nextAndIndex = findNextAndIndex(operateList, i + 1);
                int endIndex = (nextAndIndex == -1) ? operateList.size() - 1 : nextAndIndex - 1;

                // 处理AND后面的整体（从i+1到endIndex）
                processGroup(type, map, query, modeType, drugOrDisease, rangeType, operateList, i + 1, endIndex);

                // 跳过已处理的元素
                i = endIndex;

            } else if ("@NOT@".equals(wordOrOperate)) {
                String word = operateList.get(i + 1);
                query.append(" NOT ");
                extracted(type, map, query, modeType, drugOrDisease, rangeType, word);
                i++;
            } else if ("@OR@".equals(wordOrOperate)) {
                // OR操作符在processGroup中处理，这里不应该单独遇到
                // 如果遇到，说明是独立的OR，按原来的方式处理
                String word = operateList.get(i + 1);
                query.append(" OR ");
                extracted(type, map, query, modeType, drugOrDisease, rangeType, word);
                i++;
            }
        }
    }

    // 检查列表中是否有AND操作符
    private static boolean hasAndOperator(List<String> operateList) {
        return operateList.contains("@AND@");
    }

    // 找到第一个AND操作符的索引
    private static int findFirstAndIndex(List<String> operateList) {
        for (int i = 0; i < operateList.size(); i++) {
            if ("@AND@".equals(operateList.get(i))) {
                return i;
            }
        }
        return -1;
    }

    // 找到指定位置之后的下一个AND操作符的索引
    private static int findNextAndIndex(List<String> operateList, int startIndex) {
        for (int i = startIndex; i < operateList.size(); i++) {
            if ("@AND@".equals(operateList.get(i))) {
                return i;
            }
        }
        return -1;
    }

    // 处理一组元素（可能包含OR连接）
    private static void processGroup(Integer type, Map<String, Set<String>> map, StringBuilder query,
                                     int modeType, int drugOrDisease, int rangeType,
                                     List<String> operateList, int startIndex, int endIndex) {

        if (startIndex > endIndex) {
            return;
        }

        // 收集这个组内的所有非操作符元素
        List<String> groupElements = new ArrayList<>();
        for (int i = startIndex; i <= endIndex; i++) {
            String element = operateList.get(i);
            if (!"@OR@".equals(element) && !"@AND@".equals(element) && !"@NOT@".equals(element)) {
                groupElements.add(element);
            }
        }

        if (groupElements.size() == 1) {
            // 只有一个元素，直接处理
            extracted(type, map, query, modeType, drugOrDisease, rangeType, groupElements.get(0));
        } else if (groupElements.size() > 1) {
            // 多个元素，需要用括号包围并用OR连接
            query.append("(");
            for (int i = 0; i < groupElements.size(); i++) {
                if (i > 0) {
                    query.append(" OR ");
                }
                extracted(type, map, query, modeType, drugOrDisease, rangeType, groupElements.get(i));
            }
            query.append(")");
        }
    }


    private static void extracted(Integer type, Map<String, Set<String>> map, StringBuilder query, int modeType, int drugOrDisease, int rangeType, String txt) {
        Set<String> set = map.get(txt);
        if (set.isEmpty()) set.add(txt);
        if (modeType == 1) {
            if (type == 1) { // 文献
                montage(query, set);
            } else {
                montageForPaperInclusion(query, set);
            }
        }

        if (modeType == 2) { // 指南
            if (rangeType == 1) {
                montageForGuideBlock(query, set);
            } else {
                montage(query, set);
            }
        }

        if (modeType == 3) { // 临床试验
            if (drugOrDisease == 1) {
                montageForClinicalInclude(query, set);
            }
            if (drugOrDisease == 2) {
                montageForClinicalIncludeByDisease(query, set);
            }
            if (drugOrDisease == 3) {
                montageForClinical(query, set);
            }
        }
        if (modeType == 33) {
            montageForThreeClinicalByTitle(query, set);
        }

        if (modeType == 4) { // 说明书
            if (drugOrDisease == 1) {
                montageForInstructionByPrecise(query, set);
            }
            if (drugOrDisease == 2) {
                montageForInstructionInP(query, set);
            }        
        }
    }

    /**
     * 创建文献检索的query（检索式版本创建）
     *
     * @param condition 检索条件
     * @param type      1-精筛；2-纳入
     * @return 拼接后的检索条件
     */
    public static BoolQueryBuilder createPaperQuery(Condition condition, Integer type) {
        StringBuilder query = new StringBuilder();
        Map<String, Set<String>> map = new HashMap<>();
        List<String> operateList = new ArrayList<>();
        //药品
        JSONArray array = new JSONArray();
        List<Drug> drugs = condition.getDrugs();
        array.add(drugs);
        extracted(array, operateList, map, 1);
        assemble(type, operateList, map, query, 1, 1, 0);

        List<InterventionAndOutcome> interventions = condition.getInterventions();
        if (CollectionUtils.isNotEmpty(interventions)) {
            array = new JSONArray();
            array.add(interventions);
            map = new HashMap<>();
            operateList = new ArrayList<>();
            extracted(array, operateList, map, 1);
            if (CollectionUtils.isNotEmpty(operateList)) {
                query.append(" AND ");
                boolean flag = false;
                if (operateList.size() > 1){
                    flag = true;
                    query.append("(");
                }
                assemble(type, operateList, map, query, 1, 1, 0);
                if (flag){
                    query.append(")");
                }
            }
        }

        List<Disease> literatureWipeDiseases = condition.getLiteratureWipeDiseases();
        List<Disease> diseases = condition.getDiseases();
        array = new JSONArray();
        array.add(diseases);
        if (CollectionUtils.isNotEmpty(diseases)) {
            array = new JSONArray();
            array.add(diseases);
            map = new HashMap<>();
            operateList = new ArrayList<>();
            extracted(array, operateList, map, 1);
            if (CollectionUtils.isNotEmpty(operateList)) {
                query.append(" AND ");
                boolean flag = false;
                if (operateList.size() > 1){
                    flag = true;
                    query.append("(");
                }
                assemble(type, operateList, map, query, 1, 1, 0);
                if (flag){
                    query.append(")");
                }
            }
        }


        //结局指标
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        array = new JSONArray();
        array.add(outcomes);
        if (CollectionUtils.isNotEmpty(outcomes)) {
            array = new JSONArray();
            array.add(outcomes);
            map = new HashMap<>();
            operateList = new ArrayList<>();
            extracted(array, operateList, map, 1);
            if (CollectionUtils.isNotEmpty(operateList)) {
                query.append(" AND ");
                boolean flag = false;
                if (operateList.size() > 1){
                    flag = true;
                    query.append("(");
                }
                assemble(type, operateList, map, query, 1, 1, 0);
                if (flag){
                    query.append(")");
                }
            }
        }

        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        //检索式拼接条件
//        String formula = FormulaFeignUtils.formula(query.toString(), 1);
        String formula = new SearchFormula().execute(query.toString(), 1, 1, 0).toString();
        boolQuery.must().add(QueryBuilders.wrapperQuery(formula));
        //文献分类
        List<Integer> studyType = condition.getStudyType();
        TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("type", studyType);
        boolQuery.must().add(termsQueryBuilder);
        return boolQuery;
    }

    public static BoolQueryBuilder createPaperQueryWithCombo(Condition condition, Integer type, List<Integer> indices) {
        StringBuilder query = new StringBuilder();

        Map<String, Set<String>> map = new HashMap<>();

        List<String> operateList = new ArrayList<>();

        BoolQueryBuilder queryBool = new BoolQueryBuilder();

        JSONArray array = new JSONArray();
        
        array.add(condition.getDrugs());
        extracted(array, operateList, map, 1);
        assemble(type, operateList, map, query, 1, 1, 0);
        String drugsFormula = new SearchFormula().execute(query.toString(), 1, 1, 0).toString();
        queryBool.must().add(QueryBuilders.wrapperQuery(drugsFormula));

        List<InterventionAndOutcome> interventions = condition.getInterventions();
        if (CollectionUtils.isNotEmpty(interventions)) {
            array = new JSONArray();
            array.add(interventions);
            map = new HashMap<>();
            operateList = new ArrayList<>();

            extracted(array, operateList, map, 1);
            if (CollectionUtils.isNotEmpty(operateList)) {
                StringBuilder innerQuery = new StringBuilder();
                assemble(type, operateList, map, innerQuery, 1, 1, 0);
                String interventionsFormula = new SearchFormula().execute(innerQuery.toString(), 1, 1, 0).toString();
                queryBool.must().add(QueryBuilders.wrapperQuery(interventionsFormula));
            }
        }

        List<Disease> diseases = condition.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            array = new JSONArray();
            diseases = diseases.stream().filter(o -> o.getStatus() == 1).collect(Collectors.toList());
            array.add(diseases);
            map = new HashMap<>();
            operateList = new ArrayList<>();

            extracted(array, operateList, map, diseases, indices);
            if (CollectionUtils.isNotEmpty(operateList)) {
                StringBuilder innerQuery = new StringBuilder();
                assembleTest(type, operateList, map, innerQuery, 1, 1, 0);
                String diseaseFormula = new SearchFormula().execute(innerQuery.toString(), 1, 1, 0).toString();
                queryBool.must().add(QueryBuilders.wrapperQuery(diseaseFormula));
            }
        }

        //结局指标
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        if (CollectionUtils.isNotEmpty(outcomes)) {
            array = new JSONArray();
            array.add(outcomes);
            map = new HashMap<>();
            operateList = new ArrayList<>();

            extracted(array, operateList, map, 1);
            if (CollectionUtils.isNotEmpty(operateList)) {
                StringBuilder innerQuery = new StringBuilder();
                assemble(type, operateList, map, innerQuery, 1, 1, 0);
                String interventionsFormula = new SearchFormula().execute(innerQuery.toString(), 1, 1, 0).toString();
                queryBool.must().add(QueryBuilders.wrapperQuery(interventionsFormula));
            }
        }

        return queryBool;
    }

    public static BoolQueryBuilder createPaperQueryNew(Condition condition, Integer type) {
        StringBuilder query = new StringBuilder();
        
        Map<String, Set<String>> map = new HashMap<>();
        
        List<String> operateList = new ArrayList<>();

        BoolQueryBuilder queryBool = new BoolQueryBuilder();

        JSONArray array = new JSONArray();
        
        array.add(condition.getDrugs());
        extracted(array, operateList, map, 1);
        assemble(type, operateList, map, query, 1, 1, 0);
        String drugsFormula = new SearchFormula().execute(query.toString(), 1, 1, 0).toString();
        queryBool.must().add(QueryBuilders.wrapperQuery(drugsFormula));

        List<InterventionAndOutcome> interventions = condition.getInterventions();
        if (CollectionUtils.isNotEmpty(interventions)) {
            array = new JSONArray();
            array.add(interventions);
            map = new HashMap<>();
            operateList = new ArrayList<>();
            
            extracted(array, operateList, map, 1);
            if (CollectionUtils.isNotEmpty(operateList)) {
                StringBuilder innerQuery = new StringBuilder();
                assemble(type, operateList, map, innerQuery, 1, 1, 0);
                String interventionsFormula = new SearchFormula().execute(innerQuery.toString(), 1, 1, 0).toString();
                queryBool.must().add(QueryBuilders.wrapperQuery(interventionsFormula));
            }
        }

        List<Disease> diseases = condition.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            array = new JSONArray();
            array.add(diseases);
            BoolQueryBuilder diseasesQuery = buildDiseasesQuery(array, type, 1);
            if (diseasesQuery != null) {
                queryBool.must().add(diseasesQuery);
            }
        }
        
        //结局指标
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        if (CollectionUtils.isNotEmpty(outcomes)) {
            array = new JSONArray();
            array.add(outcomes);
            map = new HashMap<>();
            operateList = new ArrayList<>();
            
            extracted(array, operateList, map, 1);
            if (CollectionUtils.isNotEmpty(operateList)) {
                StringBuilder innerQuery = new StringBuilder();
                assemble(type, operateList, map, innerQuery, 1, 1, 0);
                String interventionsFormula = new SearchFormula().execute(innerQuery.toString(), 1, 1, 0).toString();
                queryBool.must().add(QueryBuilders.wrapperQuery(interventionsFormula));
            }
        }

        return queryBool;
    }
    private static void montageForPaperInclusion(StringBuilder query, Set<String> set) {
        query.append("(");
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("标题").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("标题").append("]");
        query.append(")");
    }
    private static void montageForPaper(StringBuilder query, Set<String> set) {
        query.append("(");
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("精筛").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("精筛").append("]");
        query.append(")");
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
    public static BoolQueryBuilder createGuideQuery(Condition condition) {
        StringBuilder query = new StringBuilder();

        Map<String, Set<String>> map = new HashMap<>();

        List<String> operateList = new ArrayList<>();
        //药品
        List<Drug> drugs = condition.getDrugs();

        JSONArray array = new JSONArray();

        BoolQueryBuilder queryBool = new BoolQueryBuilder();

        array.add(drugs);
        extracted(array, operateList, map, 2);
        assemble(null, operateList, map, query, 2, 1, 0);
        String drugsFormula = new SearchFormula().execute(query.toString(), 2, 1, 0).toString();
        queryBool.must().add(QueryBuilders.wrapperQuery(drugsFormula));
        
        List<Disease> diseases = condition.getDiseases();
        if (CollUtil.isNotEmpty(diseases)) {
            array = new JSONArray();
            array.add(diseases);
            map = new HashMap<>();
            operateList = new ArrayList<>();

            extracted(array, operateList, map, 2);
            if (CollectionUtils.isNotEmpty(operateList)) {
                StringBuilder innerQuery = new StringBuilder();
                assembleTest(null, operateList, map, innerQuery, 2, 1, 0);
                String diseaseFormula = new SearchFormula().execute(innerQuery.toString(), 2, 1, 0).toString();
                queryBool.must().add(QueryBuilders.wrapperQuery(diseaseFormula));
            }
        }
        return queryBool;
    }
    public static BoolQueryBuilder createGuideQueryInDisease(Condition condition) {
        StringBuilder query = new StringBuilder();

        Map<String, Set<String>> map = new HashMap<>();

        List<String> operateList = new ArrayList<>();

        JSONArray array = new JSONArray();

        List<Disease> guideWipeDiseases = condition.getGuideWipeDiseases();
        List<Disease> diseases = condition.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            array.add(diseases);
            extracted(array, operateList, map, 2);
            if (CollectionUtils.isNotEmpty(operateList)) {
                boolean flag = false;
                if (operateList.size() > 1){
                    flag = true;
                    query.append("(");
                }
                assemble(null, operateList, map, query, 2, 1, 0);
                if (flag){
                    query.append(")");
                }
            }
        }

        //检索式拼接条件
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        String formula = new SearchFormula().execute(query.toString(), 2, 1, 0).toString();
        boolQuery.must().add(QueryBuilders.wrapperQuery(formula));
        return boolQuery;
    }
    public static BoolQueryBuilder createGuideBlockQuery(Condition condition, List<Integer> indices) {
        StringBuilder query = new StringBuilder();

        Map<String, Set<String>> map = new HashMap<>();

        List<String> operateList = new ArrayList<>();
        //药品
        List<Drug> drugs = condition.getDrugs();

        JSONArray array = new JSONArray();

        array.add(drugs);
        extracted(array, operateList, map, 2);
        assembleTest(null, operateList, map, query, 2, 1, 1);

        List<Disease> diseases = condition.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            array = new JSONArray();
            diseases = diseases.stream().filter(o -> o.getStatus() == 1).collect(Collectors.toList());
            array.add(diseases);
            map = new HashMap<>();
            operateList = new ArrayList<>();

            extracted(array, operateList, map, diseases, indices);
            if (CollectionUtils.isNotEmpty(operateList)) {
                query.append(" AND (");
                StringBuilder innerQuery = new StringBuilder();
                assembleTest(null, operateList, map, innerQuery, 2, 1, 1);
                query.append(innerQuery).append(")");
            }
        }

        //检索式拼接条件
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        String formula = new SearchFormula().execute(query.toString(), 2, 1, 0).toString();
        boolQuery.must().add(QueryBuilders.wrapperQuery(formula));
        return boolQuery;
    }
    public static BoolQueryBuilder createGuideBlockQueryInDrug(Condition condition, List<Integer> indices) {
        StringBuilder query = new StringBuilder();

        Map<String, Set<String>> map = new HashMap<>();

        List<String> operateList = new ArrayList<>();
        //药品
        List<Drug> drugs = condition.getDrugs();

        JSONArray array = new JSONArray();
        array.add(drugs);
        extracted(array, operateList, map, 2);
        assembleTest(null, operateList, map, query, 2, 1, 1);

        //检索式拼接条件
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        String formula = new SearchFormula().execute(query.toString(), 2, 1, 0).toString();
        boolQuery.must().add(QueryBuilders.wrapperQuery(formula));
        return boolQuery;
    }
    private static void montageForGuideBlock(StringBuilder query, Set<String> set) {
        query.append("(");
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("block").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("block").append("]");
        query.append(")");
    }
    public static BoolQueryBuilder createClinicalTrialsQuery(Condition condition) {
        StringBuilder query = new StringBuilder();
        //药品
        List<Drug> drugs = condition.getDrugs();
        //疾病
        List<Disease> diseases = condition.getDiseases();
        //将检索条件合并
        JSONArray array = new JSONArray();
        array.add(drugs);
        if (CollectionUtils.isNotEmpty(diseases)) {
            array.add(diseases);
        }
        Map<String, Set<String>> map = new HashMap<>();
        List<String> operateList = new ArrayList<>();
        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollectionUtils.isNotEmpty(innerArr)) {
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject json = innerArr.getJSONObject(i1);
                    Integer status = json.getInteger("status");
                    if (status == 1) {
                        Set<String> set = new HashSet<>();
                        String word = json.getString("word").toLowerCase();
                        set.add(word);
                        operateList.add(word);
                        String enWord = json.getString("enWord");
                        if (StringUtils.isNotBlank(enWord)) {
                            set.add(enWord.toLowerCase());
                        }
                        JSONArray enSynonym = json.getJSONArray("enSynonym");
                        if (CollectionUtils.isNotEmpty(enSynonym)) {
                            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name"));
                                }
                            }
                        }
                        String zhWord = json.getString("zhWord");
                        if (StringUtils.isNotBlank(zhWord)) {
                            set.add(zhWord.toLowerCase());
                        }
                        JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                        if (CollectionUtils.isNotEmpty(zhSynonym)) {
                            for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name"));
                                }
                            }
                        }
                        //补充同义词
                        String expandSynonym = json.getString("expandSynonym");
                        expandSynonym = expandSynonym.replaceAll("；", ";");
                        String[] split = expandSynonym.split(";");
                        for (String txt : split) {
                            if (StringUtils.isNotBlank(txt)) {
                                set.add(txt.toLowerCase());
                            }
                        }
                        map.put(word, set);
                    } else {
                        if (status == 2) {
                            //与
                            operateList.add("@AND@");
                        } else {
                            //非
                            operateList.add("@NOT@");
                        }
                    }
                }
            }
            if (array.size() > 1 && i != array.size() - 1) {
                operateList.add("@AND@");
            }
        }
        //开始拼接guide query
        for (int i = 0; i < operateList.size(); i++) {
            String txt = operateList.get(i);
            if (i == 0) {
                Set<String> set = map.get(txt);
                montage(query, set);
                continue;
            }
            if ("@AND@".equals(txt)) {
                String txt1 = operateList.get(i + 1);
                Set<String> set = map.get(txt1);
                query.append(" AND ");
                montage(query, set);
                i++;
            } else if ("@NOT@".equals(txt)) {
                String txt1 = operateList.get(i + 1);
                Set<String> set = map.get(txt1);
                query.append(" NOT ");
                montage(query, set);
                i++;
            } else if ("@OR@".equals(txt)) {
                String txt1 = operateList.get(i + 1);
                Set<String> set = map.get(txt1);
                query.append(" OR ");
                montage(query, set);
                i++;
            }
        }
        //检索式拼接条件
//        SearchFormula searchFormula = new SearchFormula();
//        return searchFormula.execute(query.toString(), 4);
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        boolQuery.must().add(QueryBuilders.wrapperQuery(FormulaFeignUtils.formula(query.toString(), 4)));
        return boolQuery;
    }
    public static BoolQueryBuilder createClinicalTrialsInclusion(Condition condition){
        StringBuilder query = new StringBuilder();
        
        Map<String, Set<String>> map = new HashMap<>();
        
        List<String> operateList = new ArrayList<>();

        BoolQueryBuilder queryBool = new BoolQueryBuilder();

        JSONArray array = new JSONArray();
        array.add(condition.getDrugs());
        extracted(array, operateList, map, 3);
        assemble(null, operateList, map, query, 3, 3, 0);
        String drugsFormula = new SearchFormula().execute(query.toString(), 4, 1, 0).toString();
        queryBool.must().add(QueryBuilders.wrapperQuery(drugsFormula));

        List<Disease> diseases = condition.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            array = new JSONArray();
            array.add(diseases);
            map = new HashMap<>();
            operateList = new ArrayList<>();

            extracted(array, operateList, map, 3);
            if (CollectionUtils.isNotEmpty(operateList)) {
                StringBuilder innerQuery = new StringBuilder();
                assemble(null, operateList, map, innerQuery, 3, 3, 0);
                String interventionsFormula = new SearchFormula().execute(innerQuery.toString(), 4, 1, 0).toString();
                queryBool.must().add(QueryBuilders.wrapperQuery(interventionsFormula));
            }
        }
        return queryBool;
    }
    private static void montageForClinicalInclude(StringBuilder query, Set<String> set) {
        query.append("(");
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("干预措施").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("干预措施").append("]");
        query.append(")");
    }
    private static void montageForClinicalIncludeByDisease(StringBuilder query, Set<String> set) {
        query.append("(");
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("适应症").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("适应症").append("]");
        query.append(")");
    }


    private static void montageForClinical(StringBuilder query, Set<String> set) {
        query.append("(");
        montageForClinicalInTitle(query, set);

        query.append(" OR ");

        montageForClinicalInDisease(query, set);

        query.append(" OR ");

        montageForClinicalInIntervention(query, set);

        query.append(")");
    }

    private static void montageForClinicalInTitle(StringBuilder query, Set<String> set) {
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("试验题目").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("试验题目").append("]");
    }

    private static void montageForClinicalInDisease(StringBuilder query, Set<String> set) {
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("适应症").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("适应症").append("]");
    }

    private static void montageForClinicalInIntervention(StringBuilder query, Set<String> set) {
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("干预措施").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("干预措施").append("]");
    }


    /**
     * 增加的第三个临床试验 查询
     * @param condition 检索条件
     * @return 拼接后的检索条件
     */
    public static BoolQueryBuilder createThreeClinicalTrialsQueryByTitleAndKey(Condition condition){
        StringBuilder query = new StringBuilder();
        Map<String, Set<String>> map = new HashMap<>();
        List<String> operateList = new ArrayList<>();
        //药品
        List<Drug> drugs = condition.getDrugs();
        //将检索条件合并
        JSONArray array = new JSONArray();
        array.add(drugs);
        extracted(array, operateList, map, 3);
        assemble(null, operateList, map, query, 33, 1, 0);
        
        List<Disease> diseases = condition.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            array = new JSONArray();
            array.add(diseases);
            map = new HashMap<>();
            operateList = new ArrayList<>();
            extracted(array, operateList, map, 1);
            if (CollectionUtils.isNotEmpty(operateList)) {
                query.append(" AND ");
                boolean flag = false;
                if (operateList.size() > 1){
                    flag = true;
                    query.append("(");
                }
                assemble(null, operateList, map, query, 33, 1, 0);
                if (flag){
                    query.append(")");
                }
            }
        }
        //检索式拼接条件
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        boolQuery.must().add(QueryBuilders.wrapperQuery(FormulaFeignUtils.formula(query.toString(), 10)));
        return boolQuery;
    }
    
    private static void montageForThreeClinicalByTitle(StringBuilder query, Set<String> set) {
        query.append("(");
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("试验题目").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("试验题目").append("]").append(" OR ");
        montageForThreeClinicalByKey(query, set);
        query.append(")");
    }

    private static void montageForThreeClinicalByKey(StringBuilder query, Set<String> set) {
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("关键词").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("关键词").append("]");
    }




    /**
     * 创建说明书检索的query（检索式版本创建）
     *
     * @param condition 检索条件
     * @return 拼接后的检索条件
     */
    public static BoolQueryBuilder createInstructionQuery(Condition condition) {
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        
        BoolQueryBuilder queryBool = QueryBuilders.boolQuery();
        
        List<Drug> drugs = condition.getDrugs();
        for (Drug drug : drugs) {
            if (drug.getStatus() != 1) continue; 
            //将检索条件合并
            StringBuilder query = new StringBuilder();
            List<String> operateList = new ArrayList<>();
            Map<String, Set<String>> map = new HashMap<>();
            JSONArray array = new JSONArray();
            
            array.add(Arrays.asList(drug));
            extracted(array, operateList, map, 4);
            assemble(null, operateList, map, query, 4, 1, 0);

            String formula = new SearchFormula().execute(query.toString(), 3, 1, 0).toString();
            queryBool.should().add(QueryBuilders.wrapperQuery(formula));
        }
        boolQuery.must().add(queryBool);
        return boolQuery;
    }

    public static BoolQueryBuilder createInstructionQueryAndP(Condition condition) {
        StringBuilder query = new StringBuilder();
        
        Map<String, Set<String>> map = new HashMap<>();
        
        List<String> operateList = new ArrayList<>();

        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        
        //药品
        List<Drug> drugs = condition.getDrugs();
        if (CollectionUtils.isNotEmpty(drugs)) {
            drugs = drugs.subList(0, 1);
        }
        //将检索条件合并
        JSONArray array = new JSONArray();
        array.add(drugs);
        extracted(array, operateList, map, 4);
        assemble(null, operateList, map, query, 4, 1, 0);
        BoolQueryBuilder drugBool = new SearchFormula().execute(query.toString(), 3, 1, 0);
        boolQuery.must().add(drugBool);

        List<Disease> diseases = condition.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            diseases = diseases.subList(0, 1);
            array = new JSONArray();
            array.add(diseases);
            
            query = new StringBuilder();
            map = new HashMap<>();
            operateList = new ArrayList<>();
            
            extracted(array, operateList, map, 4);
            assemble(null, operateList, map, query, 4, 2, 0);
            BoolQueryBuilder diseaseBool = new SearchFormula().execute(query.toString(), 3, 1, 0);
            boolQuery.must().add(diseaseBool);
        }
        return boolQuery;
    }

    public static void montageForInstructionByPrecise(StringBuilder query, Set<String> set) {
        query.append("(");
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("精准查询").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("精准查询").append("]");
        query.append(")");
    }

    public static void montageForInstructionInP(StringBuilder query, Set<String> set) {
        query.append("(");
        List<String> inner = new ArrayList<>(set);
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            query.append(s).append("[").append("适应症").append("]").append(" OR ");
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        query.append(s).append("[").append("适应症").append("]");
        query.append(")");
    }

    
    
    





    /**
     * 查询药品相关说明书
     *
     * @param drugName 药品名称
     * @return 其他说明书名称
     */
    private static Set<String> getQueryWords(String drugName) {
        Criteria criteria = new Criteria().orOperator(Criteria.where("englishName").is(drugName), Criteria.where("englishWords").is(drugName), Criteria.where("genericName").is(drugName), Criteria.where("genericWords").is(drugName), Criteria.where("nmpaName").is(drugName), Criteria.where("nmpaWords").is(drugName));
        Set<String> queryWords = new HashSet<>();
        List<JSONObject> drugInstructions = ReleaseMongoUtil.mongo.find(new Query().addCriteria(criteria), JSONObject.class, "drug_instruction_words");
        for (JSONObject drugInstructionVO : drugInstructions) {
            String englishName = drugInstructionVO.getString("englishName");
            String genericName = drugInstructionVO.getString("genericName");
            if (StringUtils.isNotBlank(englishName)) {
                queryWords.add(englishName);
            }
            if (StringUtils.isNotBlank(genericName)) {
                queryWords.add(genericName);
            }
            String nmpaName = drugInstructionVO.getString("nmpaName");
            if (StringUtils.isNotBlank(nmpaName)) {
                queryWords.add(nmpaName);
            }
            JSONArray englishWords = drugInstructionVO.getJSONArray("englishWords");
            if (CollectionUtils.isNotEmpty(englishWords)) {
                for (int i = 0; i < englishWords.size(); i++) {
                    queryWords.add(englishWords.getString(i));
                }

            }
            JSONArray nmpaWords = drugInstructionVO.getJSONArray("nmpaWords");
            if (CollectionUtils.isNotEmpty(nmpaWords)) {
                for (int i = 0; i < nmpaWords.size(); i++) {
                    queryWords.add(nmpaWords.getString(i));
                }

            }
        }
        queryWords.add(drugName.toLowerCase());
        return queryWords;
    }
    
    
    /**
     * 创建不良反应检索的query（普通版本创建）
     *
     * @param condition   检索条件
     * @param typeDrug    1-模糊查询；2-精准查询
     * @param typeOutcome 1-模糊查询；2-精准查询
     * @param hasOutcome  true 需要拼接结局指标 false 不需要拼接结局指标
     * @return 拼接后的检索条件
     */
    public static BoolQueryBuilder createAdverseQuery(Condition condition, Integer typeDrug, Integer typeOutcome, Boolean hasOutcome) {
        String[] ranges = {"drugName", "pt", "prodAi", "ptList"};
        //药品
        List<Drug> drugs = condition.getDrugs();
        //疾病
        List<Disease> diseases = condition.getDiseases();
        //将检索条件合并
        JSONArray array = new JSONArray();
        array.add(drugs);
        if (CollectionUtils.isNotEmpty(diseases)) {
            array.add(diseases);
        }
        if (hasOutcome) {
            //结局指标
            List<InterventionAndOutcome> outcomes = condition.getOutcomes();
            if (CollectionUtils.isNotEmpty(outcomes)) {
                array.add(outcomes);
            }
        }
        List<String> drugNameAliases = new ArrayList<>();
        List<String> drugName = new ArrayList<>();
        List<String> outcomeName = new ArrayList<>();
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        Map<String, Set<String>> map = new HashMap<>();
        List<String> operateList = new ArrayList<>();
        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollectionUtils.isNotEmpty(innerArr)) {
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject json = innerArr.getJSONObject(i1);
                    Integer status = json.getInteger("status");
                    if (status == 1) {
                        Set<String> set = new HashSet<>();
                        String word = json.getString("word").toLowerCase();
                        if (i == 0) {
                            drugName.add(word);
                        }
                        if (hasOutcome) {
                            if ((array.size() == 2 && i == 1) || (array.size() == 3 && i == 2)) {
                                outcomeName.add(word);
                            }
                        }
                        set.add(word);
                        operateList.add(word);
                        String enWord = json.getString("enWord");
                        if (StringUtils.isNotBlank(enWord)) {
                            set.add(enWord.toLowerCase());
                        }
                        JSONArray enSynonym = json.getJSONArray("enSynonym");
                        if (CollectionUtils.isNotEmpty(enSynonym)) {
                            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name").toLowerCase());
                                }
                            }
                        }
                        String zhWord = json.getString("zhWord");
                        if (StringUtils.isNotBlank(zhWord)) {
                            set.add(zhWord.toLowerCase());
                        }
                        JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                        if (CollectionUtils.isNotEmpty(zhSynonym)) {
                            for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name").toLowerCase());
                                }
                            }
                        }
                        JSONArray otherSynonym = json.getJSONArray("otherSynonym");
                        if (CollectionUtils.isNotEmpty(otherSynonym)) {
                            for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name").toLowerCase());
                                }
                            }
                        }
                        //补充同义词
                        String expandSynonym = json.getString("expandSynonym");
                        if (StringUtils.isNotBlank(expandSynonym)) {
                            expandSynonym = expandSynonym.replaceAll("；", ";");
                            String[] split = expandSynonym.split(";");
                            for (String txt : split) {
                                if (StringUtils.isNotBlank(txt)) {
                                    set.add(txt.toLowerCase());
                                }
                            }
                        }
                        //别名
                        JSONArray drugNameAlias = json.getJSONArray("drugNameAlias");
                        if (CollectionUtils.isNotEmpty(drugNameAlias)) {
                            for (String txt : drugNameAlias.toJavaList(String.class)) {
                                if (StringUtils.isNotBlank(txt)) {
                                    set.add(txt.toLowerCase());
                                    drugNameAliases.add(txt);
                                }
                            }
                        }
                        map.put(word, set);
                    } else {
                        if (status == 2) {
                            //与
                            operateList.add("@AND@");
                        } else {
                            //非
                            operateList.add("@NOT@");
                        }
                    }
                }
            }
            if (array.size() > 1 && i != array.size() - 1) {
                operateList.add("@AND@");
            }
        }
        //开始拼接drugs query
        List<String> mustList = new ArrayList<>();
        List<String> notList = new ArrayList<>();
        for (int i = 0; i < operateList.size(); i++) {
            String txt = operateList.get(i);
            if (i == 0) {
                mustList.add(txt);
                continue;
            }
            if ("@AND@".equals(txt)) {
                mustList.add(operateList.get(i + 1));
                i++;
            } else if ("@NOT@".equals(txt)) {
                notList.add(operateList.get(i + 1));
                i++;
            }
        }
        for (String txt : mustList) {
            Set<String> set = map.get(txt);
            BoolQueryBuilder innerBool = QueryBuilders.boolQuery();
            for (String s : set) {
                if (drugName.contains(s) || outcomeName.contains(s) || drugNameAliases.contains(s)) {
                    if (typeDrug == 1) {
                        //模糊查询
                        MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(s, ranges);
                        multiMatchQueryBuilder.operator(Operator.AND);
                        innerBool.should().add(multiMatchQueryBuilder);
                    } else {
                        //精准查询
                        TermQueryBuilder termQuery1 = QueryBuilders.termQuery("drugName.keyword", s);
                        TermQueryBuilder termQuery2 = QueryBuilders.termQuery("indicationPt.keyword", s);
                        TermQueryBuilder termQuery3 = QueryBuilders.termQuery("prodAi.keyword", s);
                        TermQueryBuilder termQuery4 = QueryBuilders.termQuery("ptList.keyword", s);
                        innerBool.should().add(termQuery4);
                        innerBool.should().add(termQuery1);
                        innerBool.should().add(termQuery2);
                        innerBool.should().add(termQuery3);
                    }
                    if (outcomeName.contains(s)) {
                        if (typeOutcome == 1) {
                            //模糊查询
                            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(s, ranges);
                            multiMatchQueryBuilder.operator(Operator.AND);
                            innerBool.should().add(multiMatchQueryBuilder);
                        } else {
                            //精准查询
                            TermQueryBuilder termQuery1 = QueryBuilders.termQuery("drugName.keyword", s);
                            TermQueryBuilder termQuery2 = QueryBuilders.termQuery("indicationPt.keyword", s);
                            innerBool.should().add(termQuery1);
                            innerBool.should().add(termQuery2);
                            if (hasOutcome) {
                                TermQueryBuilder termQuery3 = QueryBuilders.termQuery("ptList.keyword", s);
                                innerBool.should().add(termQuery3);
                            }
                            TermQueryBuilder termQuery4 = QueryBuilders.termQuery("prodAi.keyword", s.toLowerCase());
                            innerBool.should().add(termQuery4);
                        }
                    }
                } else {
                    TermQueryBuilder termQuery1 = QueryBuilders.termQuery("drugName.keyword", s);
                    TermQueryBuilder termQuery2 = QueryBuilders.termQuery("indicationPt.keyword", s);
                    TermQueryBuilder termQuery3 = QueryBuilders.termQuery("prodAi.keyword", s.toLowerCase());
                    TermQueryBuilder termQuery4 = QueryBuilders.termQuery("ptList.keyword", s);
                    innerBool.should().add(termQuery4);
                    innerBool.should().add(termQuery1);
                    innerBool.should().add(termQuery2);
                    innerBool.should().add(termQuery3);
                }
            }
            boolQuery.must().add(innerBool);
        }
        if (CollectionUtils.isNotEmpty(notList)) {
            BoolQueryBuilder innerNotBool = QueryBuilders.boolQuery();
            for (String txt : notList) {
                Set<String> set = map.get(txt);
                for (String s : set) {
                    if (drugName.contains(s) || outcomeName.contains(s) || drugNameAliases.contains(s)) {
                        if (drugName.contains(s) || outcomeName.contains(s)) {
                            if (typeDrug == 1) {
                                //模糊查询
                                MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(s, ranges);
                                multiMatchQueryBuilder.operator(Operator.AND);
                                innerNotBool.should().add(multiMatchQueryBuilder);
                            } else {
                                //精准查询  // todo 这里的精准查询需要确认
                                TermQueryBuilder termQuery1 = QueryBuilders.termQuery("drugName.keyword", s);
                                TermQueryBuilder termQuery2 = QueryBuilders.termQuery("indicationPt.keyword", s);
                                TermQueryBuilder termQuery3 = QueryBuilders.termQuery("prodAi.keyword", s);
                                TermQueryBuilder termQuery4 = QueryBuilders.termQuery("ptList.keyword", s);
                                innerNotBool.should().add(termQuery4);
                                innerNotBool.should().add(termQuery1);
                                innerNotBool.should().add(termQuery2);
                                innerNotBool.should().add(termQuery3);
                            }
                        }
                        if (outcomeName.contains(s)) {
                            if (typeOutcome == 1) {
                                //模糊查询
                                MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(s, ranges);
                                multiMatchQueryBuilder.operator(Operator.AND);
                                innerNotBool.should().add(multiMatchQueryBuilder);
                            } else {
                                //精准查询
                                TermQueryBuilder termQuery1 = QueryBuilders.termQuery("drugName.keyword", s);
                                TermQueryBuilder termQuery2 = QueryBuilders.termQuery("indicationPt.keyword", s);
                                innerNotBool.should().add(termQuery1);
                                innerNotBool.should().add(termQuery2);
                                if (hasOutcome) {
                                    TermQueryBuilder termQuery3 = QueryBuilders.termQuery("ptList.keyword", s);
                                    innerNotBool.should().add(termQuery3);
                                }
                                TermQueryBuilder termQuery4 = QueryBuilders.termQuery("prodAi.keyword", s.toLowerCase());
                                innerNotBool.should().add(termQuery4);
                            }
                        }
                    } else {
                        TermQueryBuilder termQuery1 = QueryBuilders.termQuery("drugName.keyword", s);
                        TermQueryBuilder termQuery2 = QueryBuilders.termQuery("indicationPt.keyword", s);
                        TermQueryBuilder termQuery3 = QueryBuilders.termQuery("prodAi.keyword", s.toLowerCase());
                        TermQueryBuilder termQuery4 = QueryBuilders.termQuery("ptList.keyword", s);
                        innerNotBool.should().add(termQuery4);
                        innerNotBool.should().add(termQuery1);
                        innerNotBool.should().add(termQuery2);
                        innerNotBool.should().add(termQuery3);
                    }
                }
            }
            boolQuery.mustNot().add(innerNotBool);
        }
        return boolQuery;
    }



    
    
    // 新的构建方法
    private static BoolQueryBuilder buildDiseasesQuery(JSONArray array, Integer type, int modeType) {
        BoolQueryBuilder mainQuery = QueryBuilders.boolQuery();

        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollectionUtils.isNotEmpty(innerArr)) {
                BoolQueryBuilder arrayQuery = processInnerArray(innerArr, type, modeType);
                if (arrayQuery != null) {
                    if (array.size() > 1 && i > 0) {
                        // 多个array元素之间用OR连接（should）
                        if (mainQuery.should().isEmpty() && mainQuery.must().isEmpty()) {
                            mainQuery = QueryBuilders.boolQuery().should(mainQuery);
                        }
                        mainQuery.should(arrayQuery);
                    } else {
                        mainQuery = arrayQuery;
                    }
                }
            }
        }

        return mainQuery;
    }

    // 处理内部数组
    private static BoolQueryBuilder processInnerArray(JSONArray innerArr, Integer type, int modeType) {
        BoolQueryBuilder resultQuery = QueryBuilders.boolQuery();
        BoolQueryBuilder currentGroup = QueryBuilders.boolQuery();
        String nextOperator = null; // "AND" 或 "NOT"

        for (int i1 = 0; i1 < innerArr.size(); i1++) {
            JSONObject entity = innerArr.getJSONObject(i1);
            JSONObject synonymMapObj = entity.getJSONObject("synonymMap");
            Integer status = entity.getInteger("status");

            if (Objects.nonNull(synonymMapObj)) {
                // 处理 synonymMap 的情况
                Map<String, Set<String>> synonymMap = JSON.parseObject(
                        JSON.toJSONString(synonymMapObj),
                        new TypeReference<Map<String, Set<String>>>() {}
                );

                BoolQueryBuilder synonymQuery = QueryBuilders.boolQuery();

                // 每个 entry 都要单独处理并用 should 连接
                // 按照key长度从长到短排序
                List<Map.Entry<String, Set<String>>> sortedEntries = synonymMap.entrySet()
                        .stream()
                        .sorted((e1, e2) -> Integer.compare(e2.getKey().length(), e1.getKey().length())) // 降序：长到短
                        .collect(Collectors.toList());

                for (int index = 0; index < sortedEntries.size(); index++) {
//                    if (index > 1) break;
                    Map.Entry<String, Set<String>> entry = sortedEntries.get(index);
                    String key = entry.getKey();
                    Set<String> valueSet = entry.getValue();

                    if (valueSet.isEmpty()) valueSet.add(key);
                    // 为这个 entry 构建查询，传入索引参数（从1开始）
                    BoolQueryBuilder entryQuery = buildQueryForEntry(key, valueSet, type, index + 1, modeType);

                    if (entryQuery != null) {
                        synonymQuery.should(entryQuery);
                    }
                }
                // 将构建好的 synonymQuery 添加到当前组
                addToCurrentGroup(currentGroup, synonymQuery, nextOperator);
                nextOperator = null;

            } else {
                // 处理普通实体或操作符
                if (status == 1) {
                    // 正常词汇
                    BoolQueryBuilder entityQuery = buildQueryForEntity(entity, type);
                    addToCurrentGroup(currentGroup, entityQuery, nextOperator);
                    nextOperator = null;

                } else if (status == 2) {
                    // AND操作符
                    if (hasValidQuery(currentGroup)) {
                        resultQuery.must(currentGroup);
                        currentGroup = QueryBuilders.boolQuery();
                    }
                    nextOperator = "AND";

                } else if (status == 3) {
                    // NOT操作符
                    nextOperator = "NOT";
                }
            }
        }

        // 处理最后剩余的组
        if (hasValidQuery(currentGroup)) {
            if (hasValidQuery(resultQuery)) {
                resultQuery.must(currentGroup);
            } else {
                resultQuery = currentGroup;
            }
        }

        return hasValidQuery(resultQuery) ? resultQuery : null;
    }

    // 为单个 entry 构建查询
    private static BoolQueryBuilder buildQueryForEntry(String key, Set<String> valueSet, Integer type, int level, int modeType) {
        Map<String, Set<String>> tempMap = new HashMap<>();
        tempMap.put(key, valueSet);

        List<String> tempOperateList = new ArrayList<>();
        tempOperateList.add(key);

        StringBuilder tempQuery = new StringBuilder();
        assembleTest(type, tempOperateList, tempMap, tempQuery, modeType, 1, 0);

        if (tempQuery.length() > 0) {
//            String formula = new SearchFormula().execute(tempQuery.toString(), modeType, 1, level).toString();
//            return QueryBuilders.boolQuery().must(QueryBuilders.wrapperQuery(formula));
            return QueryBuilders.boolQuery().must(new SearchFormula().execute(tempQuery.toString(), modeType, 1, level));
        }

        return null;
    }

    // 为普通实体构建查询
    private static BoolQueryBuilder buildQueryForEntity(JSONObject entity, Integer type) {
        Map<String, Set<String>> tempMap = new HashMap<>();
        List<String> tempOperateList = new ArrayList<>();

        // 提取实体的所有词汇
        Set<String> wordSet = extractWordsFromEntity(entity);
        String word = entity.getString("word").toLowerCase();

        tempMap.put(word, wordSet);
        tempOperateList.add(word);

        StringBuilder tempQuery = new StringBuilder();
        assembleTest(type, tempOperateList, tempMap, tempQuery, 1, 1, 0);

        if (tempQuery.length() > 0) {
            String formula = new SearchFormula().execute(tempQuery.toString(), 1, 1, 0).toString();
            return QueryBuilders.boolQuery().must(QueryBuilders.wrapperQuery(formula));
        }

        return null;
    }

    // 从实体中提取词汇
    private static Set<String> extractWordsFromEntity(JSONObject entity) {
        Set<String> set = new HashSet<>();

        String word = entity.getString("word").toLowerCase();
        set.add(word);

        String enWord = entity.getString("enWord");
        if (StringUtils.isNotBlank(enWord)) {
            set.add(enWord.toLowerCase());
            set.add(enWord);
        }

        String zhWord = entity.getString("zhWord");
        if (StringUtils.isNotBlank(zhWord)) {
            set.add(zhWord.toLowerCase());
            set.add(zhWord);
        }

        JSONArray enSynonym = entity.getJSONArray("enSynonym");
        if (CollectionUtils.isNotEmpty(enSynonym)){
            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                JSONObject enObj = enSynonym.getJSONObject(i2);
                String name = enObj.getString("name");
                Boolean checked = enObj.getBoolean("checked");
                if (checked) {
                    set.add(name.toLowerCase());
                    set.add(name);
                }
            }
        }

        JSONArray zhSynonym = entity.getJSONArray("zhSynonym");
        if (CollectionUtils.isNotEmpty(zhSynonym)){
            for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                String name = jsonObject.getString("name");
                Boolean checked = jsonObject.getBoolean("checked");
                if (checked) {
                    set.add(name.toLowerCase());
                    set.add(name);
                }
            }
        }

        JSONArray otherSynonym = entity.getJSONArray("otherSynonym");
        if (CollectionUtils.isNotEmpty(otherSynonym)){
            for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                String name = jsonObject.getString("name");
                Boolean checked = jsonObject.getBoolean("checked");
                if (checked) {
                    set.add(name.toLowerCase());
                    set.add(name);
                }
            }
        }

        //补充同义词
        String expandSynonym = entity.getString("expandSynonym");
        if (StringUtils.isNotBlank(expandSynonym)) {
            expandSynonym = expandSynonym.replaceAll("；", ";");
            String[] split = expandSynonym.split(";");
            for (String txt : split) {
                if(StringUtils.isNotBlank(txt)) {
                    set.add(txt.toLowerCase());
                    set.add(txt);
                }
            }
        }

        // 增加商品名
        JSONArray commodityNames = entity.getJSONArray("commodityNames");
        if (CollectionUtils.isNotEmpty(commodityNames)) {
            set.addAll(commodityNames.stream().map(String::valueOf).distinct().collect(Collectors.toList()));
        }

        // 药品表中 五级同义词
        JSONArray zhDrugNames = entity.getJSONArray("zhDrugNames");
        if (CollectionUtils.isNotEmpty(zhDrugNames)) {
            set.addAll(zhDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
        }
        JSONArray enDrugNames = entity.getJSONArray("enDrugNames");
        if (CollectionUtils.isNotEmpty(enDrugNames)) {
            set.addAll(enDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
        }
        return set;
    }

    // 将查询添加到当前组
    private static void addToCurrentGroup(BoolQueryBuilder currentGroup, BoolQueryBuilder queryToAdd, String operator) {
        if (queryToAdd == null) return;

        if ("AND".equals(operator)) {
            currentGroup.must(queryToAdd);
        } else if ("NOT".equals(operator)) {
            currentGroup.mustNot(queryToAdd);
        } else {
            // 默认OR操作
            currentGroup.should(queryToAdd);
        }
    }

    // 检查查询是否有效
    private static boolean hasValidQuery(BoolQueryBuilder query) {
        return query != null &&
                (!query.must().isEmpty() || !query.should().isEmpty() || !query.mustNot().isEmpty());
    }
    
}



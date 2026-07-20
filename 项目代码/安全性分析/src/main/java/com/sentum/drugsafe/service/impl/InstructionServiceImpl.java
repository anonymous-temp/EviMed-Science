package com.sentum.drugsafe.service.impl;


import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.pojo.DrugAndIndicationIndex;
import com.sentum.drugsafe.pojo.InstructionIndex;
import com.sentum.drugsafe.pojo.InstructionTreeVo;
import com.sentum.drugsafe.pojo.Vo.InstructionVo;
import com.sentum.drugsafe.pojo.Vo.PageVo;
import com.sentum.drugsafe.service.InstructionService;
import com.sentum.drugsafe.trans.RedisUtil;
import com.sentum.drugsafe.utils.*;
import org.apache.commons.lang.StringUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.elasticsearch.index.query.*;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.elasticsearch.search.aggregations.bucket.terms.TermsAggregationBuilder;
import org.elasticsearch.search.aggregations.metrics.TopHitsAggregationBuilder;
import org.elasticsearch.search.fetch.subphase.highlight.HighlightBuilder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.mapping.IndexCoordinates;
import org.springframework.data.elasticsearch.core.query.*;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static com.sentum.drugsafe.utils.HighLightUtils.repairContent;

@Service
public class InstructionServiceImpl implements InstructionService {


    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private RedisTemplate redisTemplate;


    @Override
    public List<JSONObject> getInstructionTree(String id) {
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        BoolQueryBuilder instructionQuery = createInstructionQuery(userSynonm);
        redisTemplate.opsForValue().set("instruction_query_" + id, instructionQuery.toString(), 60, TimeUnit.MINUTES);
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder nmpaSourceBoolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder otherSourceBoolQueryBuilder = new BoolQueryBuilder();

        List<String> list = Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考", "其它");
        nmpaSourceBoolQueryBuilder.must().add(QueryBuilders.termsQuery("source", list));
        // nmpa的只需 使用新说明书  剔除旧说明书
        nmpaSourceBoolQueryBuilder.must().add(QueryBuilders.matchPhraseQuery("medicineUsePdf", "true"));
        boolQueryBuilder.should().add(nmpaSourceBoolQueryBuilder);

        List<String> otherList = Arrays.asList("ema", "fda", "pmda");
        otherSourceBoolQueryBuilder.must().add(QueryBuilders.termsQuery("source", otherList));
        boolQueryBuilder.should().add(otherSourceBoolQueryBuilder);

        instructionQuery.must().add(boolQueryBuilder);

        // 指定需要返回的字段
//        String[] includeFields = { "revisionData", "enterpriseName", "indication", "medicineUsePdf", "pdf_name", "simpleGenericNames", "simpleTradeNames" };
        String[] includeFields = {"source"};
        String[] excludeFields = {}; // 如果有不需要的字段，可以在这里指定
        SourceFilter sourceFilter = new FetchSourceFilter(includeFields, excludeFields);

        // 使用 NativeSearchQueryBuilder 构建查询
        NativeSearchQueryBuilder nativeSearchQueryBuilder = new NativeSearchQueryBuilder()
                .withQuery(instructionQuery);
//                .withSourceFilter(sourceFilter);

        TermsAggregationBuilder sourceAgg = AggregationBuilders.terms("source").field("source").size(20);
        TermsAggregationBuilder drugNameAgg = AggregationBuilders.terms("simpleGenericNames").field("simpleGenericNames.keyword").size(200);
        TermsAggregationBuilder manufacturersAgg = AggregationBuilders.terms("enterpriseName").field("enterpriseName.keyword").size(100);

//        String[] hitIncludeFields = { "revisionData", "enterpriseName", "indication", "medicineUsePdf", "pdf_name", "simpleGenericNames", "simpleTradeNames" };
//        TopHitsAggregationBuilder topHitsAgg = AggregationBuilders.topHits("top_hits")
//                .size(100).fetchSource(hitIncludeFields, excludeFields);
        sourceAgg.subAggregation(drugNameAgg);
        drugNameAgg.subAggregation(manufacturersAgg);
//        manufacturersAgg.subAggregation(topHitsAgg);
        nativeSearchQueryBuilder.addAggregation(sourceAgg);

        SearchHits<InstructionIndex> search = elasticsearchRestTemplate.search(nativeSearchQueryBuilder.build(), InstructionIndex.class, IndexCoordinates.of("instruction_data_index", "instructions_use_index"));
        Aggregations aggregations = search.getAggregations();

//        List<String> list = Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考", "用药助手_old");
        List<String> oneLevelList = new ArrayList<>();

        Map<String, List<String>> oneLevelMap = new LinkedHashMap<>();
        oneLevelMap.put("nmpa", new ArrayList<>());
        oneLevelMap.put("fda", new ArrayList<>());
        oneLevelMap.put("ema", new ArrayList<>());
        oneLevelMap.put("pmda", new ArrayList<>());
        Map<String, List<String>> twoLevelMap = new LinkedHashMap<>();
        Map<String, List<String>> threeLevelMap = new LinkedHashMap<>();

        if (aggregations != null) {
            Aggregation sourceAggregation = aggregations.get("source");
            List<? extends Terms.Bucket> sourceBuckets = ((ParsedTerms) sourceAggregation).getBuckets();
            for (Terms.Bucket sourceBucket : sourceBuckets) {
                String sourceKey = sourceBucket.getKey().toString();
                if (list.contains(sourceKey)) {
                    sourceKey = "nmpa";
                }
                Aggregation simpleGenericNamesAggregation = sourceBucket.getAggregations().get("simpleGenericNames");
                List<? extends Terms.Bucket> simpleGenericNamesBuckets = ((ParsedTerms) simpleGenericNamesAggregation).getBuckets();
                List<String> simpleGenericNamesList = new ArrayList<>(); // 收集所有同一来源下的说明书名称
                for (Terms.Bucket simpleGenericNamesBucket : simpleGenericNamesBuckets) {
                    String simpleGenericNamesKey = simpleGenericNamesBucket.getKey().toString();
                    String twoLevelValue = sourceKey + "-" + simpleGenericNamesKey;
                    simpleGenericNamesList.add(twoLevelValue);

                    Aggregation enterpriseNameAggregation = simpleGenericNamesBucket.getAggregations().get("enterpriseName");
                    List<? extends Terms.Bucket> enterpriseNameBuckets = ((ParsedTerms) enterpriseNameAggregation).getBuckets();
                    List<String> enterpriseNameList = new ArrayList<>(); // 收集所有同一说明书名称下的厂家
                    for (Terms.Bucket enterpriseNameBucket : enterpriseNameBuckets) {
                        String enterpriseNameKey = enterpriseNameBucket.getKey().toString();

                        String threeLevelValue = twoLevelValue + "-" + enterpriseNameKey;
//                        // 具体的结合到厂家的数据
//                        TopHits topHits = (TopHits)enterpriseNameBucket.getAggregations().get("top_hits");
//                        org.elasticsearch.search.SearchHit[] hits = topHits.getHits().getHits();
//
//                        // 将数据转为json存储
                        List<String> contentJson = new ArrayList<>();
//                        for (org.elasticsearch.search.SearchHit hit : hits) {
//                            Map<String, Object> sourceAsMap = hit.getSourceAsMap();
//                            contentJson.add(JSON.toJSONString(sourceAsMap));
//                        }

                        if (CollUtil.isNotEmpty(threeLevelMap.get(enterpriseNameKey))) {
                            threeLevelMap.get(enterpriseNameKey).addAll(contentJson);
                        } else {
                            threeLevelMap.put(enterpriseNameKey, contentJson);
                        }

                        enterpriseNameList.add(threeLevelValue);
                    }

                    if (CollUtil.isNotEmpty(twoLevelMap.get(simpleGenericNamesKey))) {
                        twoLevelMap.get(simpleGenericNamesKey).addAll(enterpriseNameList);
                    } else {
                        twoLevelMap.put(simpleGenericNamesKey, enterpriseNameList);
                    }
                }

                if (CollUtil.isNotEmpty(oneLevelMap.get(sourceKey))) {
                    oneLevelMap.get(sourceKey).addAll(simpleGenericNamesList);
                } else {
                    oneLevelMap.put(sourceKey, simpleGenericNamesList);
                }
                oneLevelList.add(sourceKey);
            }
        }

        List<JSONObject> result = new ArrayList<>();

        List<String> sourceList = Arrays.asList("fda", "ema", "pmda");

        for (Map.Entry<String, List<String>> oneEntry : oneLevelMap.entrySet()) {
            JSONObject oneNewInstructionVo = new JSONObject();
            String oneEntryKey = oneEntry.getKey();
            oneNewInstructionVo.put("term", oneEntryKey);
            List<String> oneEntryValue = oneEntry.getValue();

            if (sourceList.contains(oneEntryKey) && CollUtil.isEmpty(oneEntryValue)) {
                oneNewInstructionVo.put("value", new ArrayList<>());
                result.add(oneNewInstructionVo);
                continue;
            }
            List<JSONObject> oneData = new ArrayList<>();
            List<JSONObject> currentDrugNameAllEnterpriseName = new ArrayList<>();
            for (Map.Entry<String, List<String>> twoEntry : twoLevelMap.entrySet()) {
                JSONObject twoNewInstructionVo = new JSONObject();
                String twoEntryKey = twoEntry.getKey();
                List<String> twoEntryValue = twoEntry.getValue();

                String twoJointValue = oneEntryKey + "-" + twoEntryKey;
                if (oneEntryValue.contains(twoJointValue)) {
                    twoNewInstructionVo.put("term", twoEntryKey);

                    List<JSONObject> twoData = new ArrayList<>();
                    for (Map.Entry<String, List<String>> threeEntry : threeLevelMap.entrySet()) {
                        JSONObject threeNewInstructionVo = new JSONObject();
                        String threeEntryKey = threeEntry.getKey();

                        String subJonitValue = twoJointValue + "-" + threeEntryKey;
                        if (twoEntryValue.contains(subJonitValue)) {
                            threeNewInstructionVo.put("term", threeEntryKey);
                            threeNewInstructionVo.put("value", new ArrayList<>());
                            twoData.add(threeNewInstructionVo);
                            currentDrugNameAllEnterpriseName.add(threeNewInstructionVo);
                        }
                    }
                    JSONObject threeNewInstructionVo = new JSONObject();
                    threeNewInstructionVo.put("term", "全部");
                    threeNewInstructionVo.put("value", new ArrayList<>());
                    twoData.add(0, threeNewInstructionVo);

                    twoNewInstructionVo.put("value", twoData);
                    oneData.add(twoNewInstructionVo);
                }
            }
            // 药品全部下的厂家全部
            JSONObject threeNewInstructionVo = new JSONObject();
            threeNewInstructionVo.put("term", "全部");
            threeNewInstructionVo.put("value", new ArrayList<>());
            currentDrugNameAllEnterpriseName.add(0, threeNewInstructionVo);

            // 药品全部
            JSONObject twoNewInstructionVo = new JSONObject();
            twoNewInstructionVo.put("term", "全部");
            twoNewInstructionVo.put("value", currentDrugNameAllEnterpriseName.stream().distinct().collect(Collectors.toList()));

            oneData.add(0, twoNewInstructionVo);
            oneNewInstructionVo.put("value", oneData);
            result.add(oneNewInstructionVo);
        }
        return result;


//        ArrayList<InstructionTreeVo> instructionTreeVos = new ArrayList<>();
//        HashMap<String, Set<String>> nmpaMap = new HashMap<>();
//
//        if (aggregations != null){
//            Aggregation sourceAggregation = aggregations.get("source");
//            List<? extends Terms.Bucket> sourceBuckets = ((ParsedTerms) sourceAggregation).getBuckets();
//            for (Terms.Bucket sourceBucket : sourceBuckets) {
//                String sourceKey = sourceBucket.getKey().toString();
//                InstructionTreeVo<InstructionTreeVo> instructionTreeVo = new InstructionTreeVo();
//                if (list.contains(sourceKey)) {
//                    sourceKey = "nmpa";
//                }else {
//                    instructionTreeVos.add(instructionTreeVo);
//                    instructionTreeVo.setFatherTitle(sourceKey);
//                }
//
//                InstructionTreeVo<String> instructionTreeX = new InstructionTreeVo();
//                instructionTreeVo.getChildren().add(instructionTreeX);
//                instructionTreeX.setFatherTitle("全部");
//
//
//                Aggregation simpleGenericNamesAggregation = sourceBucket.getAggregations().get("simpleGenericNames");
//                List<? extends Terms.Bucket> simpleGenericNamesBuckets = ((ParsedTerms) simpleGenericNamesAggregation).getBuckets();
//                for (Terms.Bucket simpleGenericNamesBucket : simpleGenericNamesBuckets) {
//                    String simpleGenericNamesKey = simpleGenericNamesBucket.getKey().toString();
//                    InstructionTreeVo<String> instructionTree = new InstructionTreeVo();
//                    if (sourceKey != "nmpa"){
//                        instructionTreeVo.getChildren().add(instructionTree);
//                        instructionTree.getChildren().add(0,"全部");
//                        instructionTree.setFatherTitle(simpleGenericNamesKey);
//
//                    }else {
//                        if (!nmpaMap.containsKey(simpleGenericNamesKey)){
//                            nmpaMap.put(simpleGenericNamesKey, new HashSet<>());
//                        }
//                    }
//                    Aggregation enterpriseNameAggregation = simpleGenericNamesBucket.getAggregations().get("enterpriseName");
//                    List<? extends Terms.Bucket> enterpriseNameBuckets = ((ParsedTerms) enterpriseNameAggregation).getBuckets();
//                    HashSet<String> strings1 = new HashSet<>();
//                    for (Terms.Bucket enterpriseNameBucket : enterpriseNameBuckets) {
//                        String enterpriseNameKey = enterpriseNameBucket.getKey().toString();
//                        if (sourceKey != "nmpa"){
//                            instructionTree.getChildren().add(enterpriseNameKey);
//                            strings1.add(enterpriseNameKey);
//                        }else {
//                            Set<String> strings = nmpaMap.get(simpleGenericNamesKey);
//                            strings.add(enterpriseNameKey);
//                            nmpaMap.put(simpleGenericNamesKey, strings);
//                        }
//                    }
//                    ArrayList<String> strings = new ArrayList<>(strings1);
//                    strings.add(0,"全部");
//                    instructionTreeX.setChildren(strings);
//
//
//                }
//
//            }
//            InstructionTreeVo<InstructionTreeVo> instructionTreeVoInstructionTreeVo = new InstructionTreeVo<>();
//            Set<String> strings = new HashSet<>();
//            if (nmpaMap.size()>0){
//             nmpaMap.forEach((k, v) -> {
//                 ArrayList<String> x = new ArrayList<>(v);
//                 strings.addAll(x);
//                 x.add(0,"全部");
//                 InstructionTreeVo instructionTreeVo = new InstructionTreeVo(k, x);
//                 instructionTreeVoInstructionTreeVo.getChildren().add(instructionTreeVo);
//
//
//             });
//                ArrayList<String> strings1 = new ArrayList<>(strings);
//                strings1.add(0,"全部");
//                instructionTreeVoInstructionTreeVo.getChildren().add(0,new InstructionTreeVo("全部", strings1));
//                instructionTreeVoInstructionTreeVo.setFatherTitle("nmpa");
//                instructionTreeVos.add(0,instructionTreeVoInstructionTreeVo);
//           }
//        }


    }


    public BoolQueryBuilder createInstructionQuery(JSONObject userSynonm) {

        Set<String> strings = getDrugName(userSynonm);



        // 将字符串集合转换为不区分大小写的正则表达式
        Set<String> regexPatterns = strings.stream()
            .map(s -> "(?i)" + Pattern.quote(s))
            .collect(Collectors.toSet());





        // 构建查询条件
        Criteria criteria = new Criteria()
            .orOperator(
                Criteria.where("communityNameZh").regex(regexPatterns.stream().collect(Collectors.joining("|"))),
                Criteria.where("communityNameEn").regex(regexPatterns.stream().collect(Collectors.joining("|")))
            );

        Query queryx = new Query(criteria);

        // 检查是否存在
        boolean exists = mongoTemplate.exists(queryx, "evaluation_drug_info_v2");

      StringBuilder query = new StringBuilder();
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
    if (exists) {
            TermsQueryBuilder tradeNameQuery = QueryBuilders.termsQuery("tradeNames.keyword", strings);
            boolQuery.must().add(tradeNameQuery);
        } else {
        // 利用es 查询 中英文对应的翻译词
        BoolQueryBuilder synonymBoolQueryBuilder = QueryBuilders.boolQuery();

        BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
        for (String s : strings) {
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", s));  // 药品名称
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugName.keyword", s)); // 同义词 五级中英文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", s));  // 药品中文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", s));  // 药品英文
        }

        synonymBoolQueryBuilder.must().add(orBoolQueryBuilder);


        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(synonymBoolQueryBuilder);
        SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
        HashSet<String> strings1 = new HashSet<>();
        for (SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit : search) {
            DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
            strings1.add(content.getZhDrugName());
            strings1.addAll(content.getDrugName());
            strings1.add(content.getDrugZh());
        }
        strings.addAll(strings1);
        montageForInstructionByPrecise(query, strings);
            String formula = FormulaFeignUtil.formula(query.toString(), 3);
            boolQuery.must().add(QueryBuilders.wrapperQuery(formula));
        }
        return boolQuery;
    }


    private Set<String> getDrugName(JSONObject userSynonm) {
        HashSet<String> strings = new HashSet<>();
        if (ObjectUtils.isEmpty(userSynonm)) {
            return null;
        }

        JSONArray jsonArray = userSynonm.getJSONArray("drugs");
        for (JSONArray jsonArray1 : jsonArray.toJavaList(JSONArray.class)) {
            for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {
                String trans = jsonObject.getString("trans");
                String word = jsonObject.getString("word");
                strings.add(trans);
                strings.add(word);
//                BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
//                 orBoolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", word));  // 药品名称
//                        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugName.keyword", word)); // 同义词 五级中英文
//                        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", word));  // 商品名
//                        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", word));  // 商品名
//                        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", word));  // 药品中文
//                        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", word));  // 药品英文
//                        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(orBoolQueryBuilder);
//                        SearchHits<DrugAndIndicationIndex> searchZh = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
//                        if (searchZh.getTotalHits() > 0){
//                            SearchHit<DrugAndIndicationIndex> searchHit = searchZh.getSearchHit(0);
//                            DrugAndIndicationIndex content = searchHit.getContent();
//                            strings.addAll(content.getDrugName());
//                            strings.add(content.getDrugEn());
//                            strings.remove("");
//                        }


            }

        }
        return strings;
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


    /**
     * Retrieves a paginated list of instructions based on the provided search criteria and parameters.
     * The method performs querying, filtering, and highlighting operations using Elasticsearch and MongoDB,
     * and returns the results in a structured format.
     *
     * @param id the unique identifier used to fetch user-specific synonym data from MongoDB
     * @param oneLevelTerm the first level term used for filtering results by source; supports specific values like "nmpa"
     * @param twoLevelTerm the second level term used for filtering results by generic names; ignored if value is "全部"
     * @param threeLevelTerm the third level term used for filtering results by enterprise names; ignored if value is "全部"
     * @param pageSize the number of items to display per page
     * @param pageNum the current page number for pagination
     * @param search a search keyword or phrase used for additional filtering and highlighting
     * @return a PageVo object containing the paginated list of InstructionVo, total hits, total pages, and pagination details
     */
    @Override
    public PageVo<InstructionVo> navigationList(String id, String oneLevelTerm, String twoLevelTerm, String threeLevelTerm, Integer pageSize, Integer pageNum, String search) {
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        String o = (String) redisTemplate.opsForValue().get("instruction_query_" + id);
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        boolQueryBuilder.must().add(QueryBuilders.wrapperQuery(o));
        Set<String> strings = getDrugName(userSynonm);

        if (StrUtil.isNotBlank(oneLevelTerm)) {
            if ("nmpa".equalsIgnoreCase(oneLevelTerm)) {
                List<String> list = Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考", "其它");
                boolQueryBuilder.must().add(QueryBuilders.termsQuery("source", list));
                boolQueryBuilder.must().add(QueryBuilders.matchPhraseQuery("medicineUsePdf", "true"));
            } else {
                boolQueryBuilder.must().add(QueryBuilders.termQuery("source", oneLevelTerm.toLowerCase()));
            }
        }

        if (StrUtil.isNotBlank(twoLevelTerm) && !"全部".equalsIgnoreCase(twoLevelTerm)) {
            TermQueryBuilder simpleGenericNames = QueryBuilders.termQuery("simpleGenericNames.keyword", twoLevelTerm);
            boolQueryBuilder.must().add(simpleGenericNames);
        }

        if (StrUtil.isNotBlank(threeLevelTerm) && !"全部".equalsIgnoreCase(threeLevelTerm)) {
            TermQueryBuilder simpleTradeNames = QueryBuilders.termQuery("enterpriseName.keyword", threeLevelTerm);
            boolQueryBuilder.must().add(simpleTradeNames);
        }

        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        nativeSearchQuery.setPageable(PageRequest.of(pageNum - 1, pageSize));
        String preTag = "<b>";
        String postTag = "</b>";
        HighlightBuilder highlightBuilder = new HighlightBuilder();
        highlightBuilder.field("simpleGenericNames");
        highlightBuilder.field("indication");
        highlightBuilder.preTags(preTag);
        highlightBuilder.postTags(postTag);
        highlightBuilder.fragmentSize(1024 * 10);
        highlightBuilder.numOfFragments(0);
        highlightBuilder.requireFieldMatch(false);
        nativeSearchQuery.setHighlightQuery(new HighlightQuery(highlightBuilder));

        SearchHits<InstructionIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class, IndexCoordinates.of("instruction_data_index", "instructions_use_index"));
// 干掉高亮
        Object objectStopWord = RedisUtil.redis.opsForValue().get("jieba_word");
        List<String> stopWord = ObjectToListUtil.objToList(objectStopWord, String.class);
        List<InstructionVo> list = new ArrayList<>();
        for (SearchHit<InstructionIndex> searchHit : searchHits) {
            InstructionIndex instructionIndex = searchHit.getContent();
            //高亮
            List<String> titleList = searchHit.getHighlightField("simpleGenericNames");
            StringBuilder titleBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(titleList)) {
                titleList.forEach(titleBuilder::append);
            }
            instructionIndex.setSimpleGenericNames(StringUtils.isBlank(titleBuilder.toString()) ? instructionIndex.getSimpleGenericNames() : HighLightUtils.highLight(repairContent(titleBuilder.toString(), instructionIndex.getSimpleGenericNames(), stopWord), instructionIndex.getSimpleGenericNames(), strings, search));
            List<String> indicationList = searchHit.getHighlightField("indication");
            StringBuilder indicationBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(indicationList)) {
                indicationList.forEach(indicationBuilder::append);
            }
            instructionIndex.setIndication(StringUtils.isBlank(indicationBuilder.toString()) ? instructionIndex.getIndication() : HighLightUtils.highLight(repairContent(indicationBuilder.toString(), instructionIndex.getIndication(), stopWord), instructionIndex.getIndication(), strings, search));
            String indication = instructionIndex.getIndication();
            if (StrUtil.isNotBlank(indication)) {
                instructionIndex.setIndication(instructionIndex.getIndication().replaceAll("</?[^/?(b)][^><]*>", " "));
            }
            InstructionVo instructionVo = FormatUtil.formInstruction(instructionIndex);
            //判断收藏情况
            /*Criteria criteria = Criteria.where("instructionId").is(instructionIndex.getPdf_name()).and("userId").is(userId).and("conditionId").is(id);
            InstructionCollect collect = mongoTemplate.findOne(new Query(criteria), InstructionCollect.class);
            if (collect != null){
                instructionVo.setCollectionMark(1);
            }*/
            list.add(instructionVo);
        }
        long totalHits = searchHits.getTotalHits();
        int pages = (int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1);
        list = list.stream().sorted(Comparator.comparing(InstructionVo::getMedicineUsePdf, Comparator.reverseOrder())).collect(Collectors.toList());
        PageVo<InstructionVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        return page;
    }


}

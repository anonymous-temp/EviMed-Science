package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.dto.*;
import com.sentum.evidencecomprehensive.domain.dto.ai.HomePage;
import com.sentum.evidencecomprehensive.domain.enums.ExceptionEnum;
import com.sentum.evidencecomprehensive.domain.es.DrugAndIndicationIndex;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;
import com.sentum.evidencecomprehensive.domain.es.EvidenceClinicalTrials;
import com.sentum.evidencecomprehensive.domain.mongo.*;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.req.*;
import com.sentum.evidencecomprehensive.exception.BusinessException;
import com.sentum.evidencecomprehensive.feign.MedicineFeign;
import com.sentum.evidencecomprehensive.feign.SystemFeign;
import com.sentum.evidencecomprehensive.service.AiService;
import com.sentum.evidencecomprehensive.service.QuestionService;
import com.sentum.evidencecomprehensive.service.RetrievalService;
import com.sentum.evidencecomprehensive.service.adapter.SynonymGenerateAdapter;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import com.sentum.evidencecomprehensive.utils.SynonymUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.AIRequestUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.elasticsearch.index.query.*;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import javax.servlet.http.HttpServletRequest;
import java.lang.reflect.Type;
import java.time.Instant;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiFunction;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
public class RetrievalServiceImpl implements RetrievalService {
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private QuestionService questionService;
    @Autowired
    private MedicineFeign medicineFeign;
    @Autowired
    private AiService aiService;
    @Autowired
    private SystemFeign systemFeign;

    @Override
    public JSONArray typeList() {
        JSONArray result = new JSONArray();
        //旧版本 0-Review；1-case-report/case-series；3-Meta/系统评价；4-RCT/nRCT；5-观察性研究；6-经济学研究；7-临床试验；9-基础研究
        //新版本 系统综述/Meta分析 0；综述 1；随机对照试验 2；队列研究 3；病例对照研究 4；横断面研究 5；病例系列 6；病例报告 7；
        //       专家意见和评价 8；动物试验 9；体外试验 10；指南/专家共识 11；经济学评价 12；其他 13
        List<Integer> typeList = Arrays.asList(0, 1, 2, 14, 3, 4, 5, 6, 7, 8, 11, 12, 9, 10, 13);
        List<String> nameList = Arrays.asList("系统综述/Meta分析", "传统综述", "随机对照试验", "临床试验", "队列研究", "病例对照研究", "横断面研究", "病例系列", "病例报告",
                "专家意见和评价", "指南/共识", "经济学评价", "动物实验", "体外实验", "其他");
        for (int i = 0; i < typeList.size(); i++) {
            JSONObject inner = new JSONObject();
            inner.put("name", nameList.get(i));
            inner.put("type", typeList.get(i));
            result.add(inner);
        }
        return result;
    }

    @Override
    public JSONObject synonym(String word, Integer range, Integer isTranslate) {
        String translate = innerSynonym(word);
        return SynonymUtils.synonym(word, range, isTranslate, translate);
    }

    private String innerSynonym(String str) {
        if (StrUtil.containsAny(str, Constants.NEES_WIPE_OUT.toArray(new String[0]))) {
            str = str.replaceAll(String.join("|", Constants.NEES_WIPE_OUT), "");
        }
        
        boolean judgeChinese = str.getBytes().length != str.length();
        str = str.trim();
        String translate = "";

        // 利用es 查询 中英文对应的翻译词
        BoolQueryBuilder synonymBoolQueryBuilder = QueryBuilders.boolQuery();

        BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", str));  // 药品名称
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugName.keyword", str)); // 同义词 五级中英文
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", str));  // 商品名
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", str));  // 商品名
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", str));  // 药品中文
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", str));  // 药品英文
        synonymBoolQueryBuilder.must().add(orBoolQueryBuilder);

        BoolQueryBuilder notBlankBoolQueryBuilder = QueryBuilders.boolQuery();
        if (judgeChinese) {
            notBlankBoolQueryBuilder.must().add(QueryBuilders.existsQuery("drugEn"));
            notBlankBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("drugEn.keyword", ""));
        } else {
            notBlankBoolQueryBuilder.must().add(QueryBuilders.existsQuery("drugZh"));
            notBlankBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("drugZh.keyword", ""));
        }
        synonymBoolQueryBuilder.must().add(notBlankBoolQueryBuilder);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(synonymBoolQueryBuilder);
        SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, DrugAndIndicationIndex.class);
        if (Objects.nonNull(drugAndIndicationIndexSearchHit)) {
            DrugAndIndicationIndex drugInfo = drugAndIndicationIndexSearchHit.getContent();
            if (judgeChinese) {
                translate = drugInfo.getDrugEn();
            } else {
                translate = drugInfo.getDrugZh();
            }
        }

        if (StringUtils.isEmpty(translate)) {
            Criteria criteria2 = new Criteria();
            criteria2.orOperator(Criteria.where("adrs_en").is(str), Criteria.where("adrs_ch").is(str));
            JSONObject one = ReleaseMongoUtil.mongo.findOne(new Query(criteria2), JSONObject.class, "fears_vigi_adrs");
            if (ObjectUtils.isNotEmpty(one)) {
                if (judgeChinese) {
                    translate = one.getString("adrs_en").toLowerCase();
                } else {
                    translate = one.getString("adrs_ch").toLowerCase();
                }
            }
        }

        if (StringUtils.isBlank(translate)) {
            JSONObject drug1 = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("words").is(str)), JSONObject.class, "drug_name_words");
            if (ObjectUtils.isNotEmpty(drug1)) {
                if (judgeChinese) {
                    translate = drug1.getString("standardName").toLowerCase();
                } else {
                    translate = drug1.getString("zhStandardName").toLowerCase();
                }
            }
        }
        return translate;
    }

    private String innerSynonym_old(String str) {
        boolean judgeChinese = str.getBytes().length != str.length();
        str = str.trim();
        String translate = "";
        Criteria criteria = new Criteria();
        criteria.orOperator(Criteria.where("drugName").regex("(?i)^" + str + "$"),
                Criteria.where("drugZh").regex("(?i)^" + str + "$"),
                Criteria.where("drugEn").regex("(?i)^" + str + "$"),
                Criteria.where("drugSynonymEn").regex("(?i)^" + str + "$"),
                Criteria.where("drugSynonymZh").regex("(?i)^" + str + "$")
        );

        Query query1 = new Query(criteria.and("drugEn").ne("").and("drugZh").ne(""));
        JSONObject drugInfo = ReleaseMongoUtil.mongo.findOne(query1, JSONObject.class, "evaluation_drug_info");
        Criteria criteriaCommunity = new Criteria();
        criteriaCommunity.orOperator(Criteria.where("communityNameEn").regex("(?i)^" + str + "$"),
                Criteria.where("communityNameZh").regex("(?i)^" + str + "$")
        );
        JSONObject communityInfo = ReleaseMongoUtil.mongo.findOne(new Query(criteriaCommunity.and("drugEn").ne("").and("drugZh").ne("")), JSONObject.class, "evaluation_drug_info");
        if (Objects.nonNull(drugInfo) || Objects.nonNull(communityInfo)) {
            if (judgeChinese) {
                if (Objects.nonNull(drugInfo)) {
                    translate = drugInfo.getString("drugEn").toLowerCase();
                } else {
                    translate = communityInfo.getString("communityNameEn").toLowerCase();
                }
            } else {
                if (Objects.nonNull(drugInfo)) {
                    translate = drugInfo.getString("drugZh").toLowerCase();
                } else {
                    translate = communityInfo.getString("communityNameZh").toLowerCase();
                }
            }
        }
        if (StringUtils.isEmpty(translate)) {
            Criteria criteria2 = new Criteria();
            criteria2.orOperator(Criteria.where("adrs_en").is(str), Criteria.where("adrs_ch").is(str));
            JSONObject one = ReleaseMongoUtil.mongo.findOne(new Query(criteria2), JSONObject.class, "fears_vigi_adrs");
            if (ObjectUtils.isNotEmpty(one)) {
                if (judgeChinese) {
                    translate = one.getString("adrs_en").toLowerCase();
                } else {
                    translate = one.getString("adrs_ch").toLowerCase();
                }
            }
        }

        if (StringUtils.isBlank(translate)) {
            JSONObject drug1 = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("words").is(str)), JSONObject.class, "drug_name_words");
            if (ObjectUtils.isNotEmpty(drug1)) {
                if (judgeChinese) {
                    translate = drug1.getString("standardName").toLowerCase();
                } else {
                    translate = drug1.getString("zhStandardName").toLowerCase();
                }
            }
        }
        return translate;
    }
    
    @Override
    public Boolean synonymFeedback(SynonymFeedbackRequest synonymFeedbackRequest, Long userId) {
        SynonymFeedback synonymFeedback = new SynonymFeedback();
        synonymFeedback.setUserId(userId);
        String word = synonymFeedback.getWord();
        List<WordStatus> zhSynonym = synonymFeedbackRequest.getZhSynonym();
        List<WordStatus> enSynonym = synonymFeedbackRequest.getEnSynonym();
        synonymFeedback.setWord(word);
        synonymFeedback.setZhSynonym(zhSynonym);
        synonymFeedback.setEnSynonym(enSynonym);
        try {
            mongoTemplate.save(synonymFeedback);
            return true;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return false;
    }

    @Override
    public JSONObject drugInfo(String drug) {
        JSONObject result = new JSONObject();
        //药品名称
        result.put("name", new ArrayList<>());
        //剂型
        result.put("dosageForm", new ArrayList<>());
        Set<String> name = new HashSet<>();
        Set<String> dosageForm = new HashSet<>();
        //判断是否为商品名
        MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(drug, "commodityNameZh", "commodityNameEn");
        multiMatchQueryBuilder.operator(Operator.AND);
        multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
        SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(new NativeSearchQuery(multiMatchQueryBuilder), DrugAndIndicationIndex.class);
        if (search.getTotalHits() > 0){
            for (SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit : search) {
                DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
                String zhDrugName = content.getZhDrugName();
                String realDosageForm = content.getDosageForm();
                name.add(zhDrugName);
                dosageForm.add(realDosageForm);
            }
        }else {
            //非商品名称
            MultiMatchQueryBuilder multiMatchBuilder = QueryBuilders.multiMatchQuery(drug, "drugName");
            multiMatchBuilder.operator(Operator.AND);
            multiMatchBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(multiMatchBuilder);
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("dosageForm").field("dosageForm.keyword").size(30));
            SearchHits<DrugAndIndicationIndex> search2 = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
            Aggregations aggregations = search2.getAggregations();
            if (Objects.nonNull(aggregations)) {
                List<? extends Terms.Bucket> doseFormBuckets = ((ParsedTerms) aggregations.get("dosageForm")).getBuckets();
                for (int i = 0; i < doseFormBuckets.size(); i++) {
                    Terms.Bucket bucket = doseFormBuckets.get(i);
                    dosageForm.add(bucket.getKey().toString());
                }
            }
        }
        result.getJSONArray("name").addAll(name);
        result.getJSONArray("dosageForm").addAll(dosageForm);
        return result;
    }

    @Override
    public PageVo<String> disease(DrugRequest drugRequest) {
        Integer isTranslate = drugRequest.getIsTranslate();
        Integer pageSize = drugRequest.getPageSize();
        Integer pageNum = drugRequest.getPageNum();
        String search = drugRequest.getSearch();
        List<Drug> drugDtoDrugs = drugRequest.getDrugs();
        //去重
        Set<String> set = new HashSet<>();
        for (int i = 0; i < drugDtoDrugs.size(); i++) {
            List<String> searchWord = new ArrayList<>();
            Drug drug = drugDtoDrugs.get(i);
            Integer status = drug.getStatus();
            if (status == 3){
                i++;
                continue;
            }
            if (status == 2){
                continue;
            }
            String txt = drug.getWord();
            boolean judgeChinese = txt.getBytes().length != txt.length();
//            List<WordStatus> zhSynonym = drug.getZhSynonym();
            String zhName = drug.getZhWord();
//            List<WordStatus> enSynonym = drug.getEnSynonym();
            String enName = drug.getEnWord();
            String expandSynonym = drug.getExpandSynonym();
//            if (CollUtil.isNotEmpty(zhSynonym)){
//                for (WordStatus wordStatus : zhSynonym) {
//                    String name = wordStatus.getName();
//                    Boolean checked = wordStatus.getChecked();
//                    if (checked){
//                        searchWord.add(name);
//                    }
//                }
//            }
//            if (CollUtil.isNotEmpty(enSynonym)){
//                for (WordStatus wordStatus : enSynonym) {
//                    String name = wordStatus.getName();
//                    Boolean checked = wordStatus.getChecked();
//                    if (checked){
//                        searchWord.add(name);
//                    }
//                }
//            }
            if (StringUtils.isNotBlank(txt)){
                searchWord.add(txt);
            }
            if (StringUtils.isNotBlank(zhName)){
                searchWord.add(zhName);
            }
            if (StringUtils.isNotBlank(enName)){
                searchWord.add(enName);
            }
            if (StringUtils.isNotBlank(expandSynonym)){
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] split = expandSynonym.split(";");
                searchWord.addAll(Arrays.asList(split));
            }
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            for (String word : searchWord) {
                MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("drugName", word);
                /*if (judgeChinese){
                    //中文
                    matchQueryBuilder = QueryBuilders.matchQuery("diseaseZh", word);
                }else {
                    //英文
                    matchQueryBuilder = QueryBuilders.matchQuery("diseaseEn", word);
                }*/
                matchQueryBuilder.operator(Operator.AND);
                boolQueryBuilder.should().add(matchQueryBuilder);
            }
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
            nativeSearchQuery.setTrackTotalHits(true);
            long count = elasticsearchRestTemplate.count(nativeSearchQuery, DrugAndIndicationIndex.class);
            List<DrugAndIndicationIndex> indexList = new ArrayList<>();
            if (count > 300){
                count = 300;
            }
            if (count > 0) {
                nativeSearchQuery.setPageable(PageRequest.of(0, (int) count));
                SearchHits<DrugAndIndicationIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
                for (SearchHit<DrugAndIndicationIndex> searchHit : searchHits) {
                    indexList.add(searchHit.getContent());
                }
                for (DrugAndIndicationIndex content : indexList) {
                    if (isTranslate == 1) {
                        //翻译
                        List<String> diseaseZh = content.getDiseaseZh();
                        if (CollUtil.isNotEmpty(diseaseZh)) {
                            for (String word : diseaseZh) {
                                set.add(word.toLowerCase());
                            }
                        }
                    } else {
                        //不翻译
                        List<String> disease;
                        if (judgeChinese) {
                            disease = content.getDiseaseZh();
                        } else {
                            disease = content.getDiseaseEn();
                        }
                        if (CollUtil.isNotEmpty(disease)) {
                            for (String word : disease) {
                                set.add(word.toLowerCase());
                            }
                        }
                    }
                }
            }
        }
        //中文上浮
        List<String> zh = new ArrayList<>();
        List<String> en = new ArrayList<>();
        for (String txt : set) {
            if (txt.getBytes().length != txt.length()){
                zh.add(txt);
            }else {
                en.add(txt);
            }
        }
        List<String> list = new ArrayList<>();
        list.addAll(zh);
        list.addAll(en);
        if (StringUtils.isNotBlank(search)){
            List<String> afterList = new ArrayList<>();
            search = search.toLowerCase();
            for (String txt : list) {
                if (txt.contains(search)){
                    txt = txt.replaceAll(search, "<span>" + search + "</span>");
                    afterList.add(txt);
                }
            }
            list = afterList;
        }
        PageVo<String> page = new PageVo<>();
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        long total = list.size();
        page.setTotal(total);
        //开始计算每页内容
        List<String> pageList = new ArrayList<>();
        if (total > 0) {
            if ((long) pageSize * pageNum > total) {
                if ((pageNum - 1) * pageSize > list.size()) {
                    pageList.addAll(list.subList((int) total - pageSize, (int) total));
                } else {
                    pageList.addAll(list.subList((pageNum - 1) * pageSize, (int) total));
                }
            } else {
                pageList.addAll(list.subList((pageNum - 1) * pageSize, pageNum * pageSize));
            }
        }
        page.setList(pageList);
        page.setPages((int) (total % pageSize == 0 ? total / pageSize : total / pageSize + 1));
        return page;
    }

    @Override
    public PageVo<String> icd10(DrugRequest drugRequest) {
        Integer isTranslate = drugRequest.getIsTranslate();
        Integer pageSize = drugRequest.getPageSize();
        Integer pageNum = drugRequest.getPageNum();
        String search = drugRequest.getSearch();
        List<String> drugs = new ArrayList<>();
        List<Drug> drugDtoDrugs = drugRequest.getDrugs();
        for (Drug drug : drugDtoDrugs) {
            Integer status = drug.getStatus();
            if (status == 1){
                drugs.add(drug.getWord());
            }else if (status == 2){
                drugs.add("AND");
            }else {
                drugs.add("NOT");
            }
        }
        StringBuilder builder = new StringBuilder();
        for (String drug : drugs) {
            builder.append(drug);
        }
        boolean judgeChinese = builder.toString().getBytes().length != builder.toString().length();
        Query query = new Query();
        if (StringUtils.isNotBlank(search)){
            search = search.toLowerCase();
            if (search.getBytes().length != search.length()) {
                query.addCriteria(Criteria.where("chinese_name").regex(search));
            }else {
                query.addCriteria(Criteria.where("chinese_name").regex(search));
            }
        }
        long total =ReleaseMongoUtil.mongo.count(query, Icd11.class);
        query.with(PageRequest.of(pageNum - 1, pageSize));
        List<Icd11> icd11s = ReleaseMongoUtil.mongo.find(query, Icd11.class);
        List<String> list = new ArrayList<>();
        for (Icd11 icd11 : icd11s) {
            String diagnosis;
            diagnosis = icd11.getChinese_name();
//            if (isTranslate == 1){
//                diagnosis = icd10.getDiagnosisChinese();
//            }else {
//                if (judgeChinese){
//                    diagnosis = icd10.getDiagnosisChinese();
//                }else {
//                    diagnosis = icd10.getDiagnosisEnglish();
//                }
//            }
            if (StringUtils.isNotBlank(search)){
                diagnosis = diagnosis.replaceAll(search, "<span>" + search + "</span>");
            }
            list.add(diagnosis);
        }
        PageVo<String> page = new PageVo<>();
        page.setTotal(total);
        page.setPageNum(pageNum);
        page.setPageSize(pageSize);
        page.setPages((int) (total % pageSize == 0 ? total / pageSize : total / pageSize + 1));
        page.setList(list);
        return page;
    }

    @Override
    public PageVo<String> referenceDrug(DrugRequest drugRequest) {
        Integer isTranslate = drugRequest.getIsTranslate();
        Integer pageSize = drugRequest.getPageSize();
        Integer pageNum = drugRequest.getPageNum();
        String search = drugRequest.getSearch();
        List<Drug> drugDtoDrugs = drugRequest.getDrugs();
        //atc
        Set<String> actSet = new HashSet<>();
        //临床试验
        Set<String> clinicalSet = new HashSet<>();
        //查询同义词，最终检索数据
        for (int i = 0; i < drugDtoDrugs.size(); i++) {
            Drug drug = drugDtoDrugs.get(i);
            Integer status = drug.getStatus();
            if (status == 3){
                i++;
                continue;
            }
            if (status == 2){
                continue;
            }
            String word = drug.getWord();
            boolean judgeChinese = word.getBytes().length != word.length();
            List<String> realSearch = new ArrayList<>();
            List<WordStatus> zhSynonym = drug.getZhSynonym();
            String zhName = drug.getZhWord();
            List<WordStatus> enSynonym = drug.getEnSynonym();
            String enName = drug.getEnWord();
            String expandSynonym = drug.getExpandSynonym();
            if (CollUtil.isNotEmpty(zhSynonym)){
                for (WordStatus wordStatus : zhSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        realSearch.add(name);
                    }
                }
            }
            if (CollUtil.isNotEmpty(enSynonym)){
                for (WordStatus wordStatus : enSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        realSearch.add(name);
                    }
                }
            }
            List<WordStatus> otherSynonym = drug.getOtherSynonym();
            if (CollUtil.isNotEmpty(otherSynonym)){
                for (WordStatus wordStatus : otherSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked) {
                        realSearch.add(name);
                    }
                }
            }
            if (StringUtils.isNotBlank(zhName)){
                realSearch.add(zhName);
            }
            if (StringUtils.isNotBlank(enName)){
                realSearch.add(enName);
            }
            if (StringUtils.isNotBlank(expandSynonym)){
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] split = expandSynonym.split(";");
                realSearch.addAll(Arrays.asList(split));
            }
            //ACT（1~4级无，药品名称+5级找最小单元）
            //先判断是否为产品名称
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            List<String> ranges = Arrays.asList("zhDrugName", "commodityNameZh", "commodityNameEn");
            for (String range : ranges) {
                boolQueryBuilder.should().add(QueryBuilders.termsQuery(range, realSearch));
            }
            SearchHits<DrugAndIndicationIndex> drugAndIndicationIndexSearchHits = elasticsearchRestTemplate.search(new NativeSearchQuery(boolQueryBuilder), DrugAndIndicationIndex.class);
            if (drugAndIndicationIndexSearchHits.getTotalHits() > 0){
                List<String> level5 = new ArrayList<>();
                //当前药品为产品名称
                if (isTranslate == 2){
                    //不翻译
                    for (SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit : drugAndIndicationIndexSearchHits) {
                        DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
                        List<String> drugNames;
                        if (judgeChinese){
                            drugNames = content.getZhDrugNames();
                        }else {
                            drugNames = content.getEnDrugNames();
                        }
                        if (CollUtil.isNotEmpty(drugNames)){
                            for (String drugName : drugNames) {
                                level5.add(drugName.toLowerCase());
                            }
                        }
                    }
                }else {
                    //翻译
                    for (SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit : drugAndIndicationIndexSearchHits) {
                        DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
                        List<String> drugNames = content.getDrugName();
                        if (CollUtil.isNotEmpty(drugNames)){
                            for (String drugName : drugNames) {
                                level5.add(drugName.toLowerCase());
                            }
                        }
                    }
                }
                if (CollUtil.isNotEmpty(level5)){
                    realSearch = level5;
                }
            }
            //ATC表中检索
            Criteria criteria = new Criteria();
            Criteria criteriaWord = new Criteria();
            //判断5级
            Criteria criteria1 = Criteria.where("codeLevel").is(4);
            Criteria criteria2 = Criteria.where("zhWord").in(realSearch);
            Criteria criteria3 = Criteria.where("enWord").in(realSearch);
            Criteria criteria4 = Criteria.where("synonym").in(realSearch);
            criteriaWord.orOperator(criteria2, criteria3, criteria4);
            criteria.andOperator(criteria1, criteriaWord);
            Query query = new Query(criteria);
            query.with(PageRequest.of(0, 3));
            List<EvidenceAct> evidenceActs = mongoTemplate.find(query, EvidenceAct.class);
            List<String> codes = new ArrayList<>();
            for (EvidenceAct evidenceAct : evidenceActs) {
                String code = evidenceAct.getCode();
                codes.add(code);
            }
            List<EvidenceAct> realEvidenceActs = mongoTemplate.find(new Query(Criteria.where("code").in(codes)), EvidenceAct.class);
            for (EvidenceAct realEvidenceAct : realEvidenceActs) {
                List<String> realSynonym = realEvidenceAct.getSynonym();
                String enWord = realEvidenceAct.getEnWord();
                String zhWord = realEvidenceAct.getZhWord();
                if (isTranslate == 2){
                    //不翻译
                    if (judgeChinese){
                        actSet.add(zhWord);
                        for (String txt : realSynonym) {
                            if (txt.getBytes().length != txt.length()){
                                actSet.add(txt);
                            }
                        }
                    }else {
                        actSet.add(enWord);
                        for (String txt : realSynonym) {
                            if (txt.getBytes().length == txt.length()){
                                actSet.add(txt);
                            }
                        }
                    }
                }else {
                    //翻译
                    actSet.add(zhWord);
                    for (String txt : realSynonym) {
                        if (txt.getBytes().length != txt.length()){
                            actSet.add(txt);
                        }
                    }
                }
            }
            //临床试验干预措施
            BoolQueryBuilder clinicalBoolQueryBuilder = QueryBuilders.boolQuery();
            for (String s : realSearch) {
                MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("intervention", s);
                matchQueryBuilder.operator(Operator.AND);
                clinicalBoolQueryBuilder.should().add(matchQueryBuilder);
            }
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(clinicalBoolQueryBuilder);
            nativeSearchQuery.setTrackTotalHits(true);
            long count = elasticsearchRestTemplate.count(nativeSearchQuery, EvidenceClinicalTrials.class);
            List<EvidenceClinicalTrials> indexList = new ArrayList<>();
            if (count > 300){
                count = 300;
            }
            if (count > 0) {
                nativeSearchQuery.setPageable(PageRequest.of(0, (int) count));
                SearchHits<EvidenceClinicalTrials> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, EvidenceClinicalTrials.class);
                for (SearchHit<EvidenceClinicalTrials> searchHit : searchHits) {
                    indexList.add(searchHit.getContent());
                }
                for (EvidenceClinicalTrials evidenceClinicalTrials : indexList) {
                    List<String> intervention = evidenceClinicalTrials.getIntervention();
                    Integer type = evidenceClinicalTrials.getType();
                    if (isTranslate == 1) {
                        //翻译
                        if (type == 1) {
                            //中文临床试验
                            for (String txt : intervention) {
                                String[] split = txt.split("卐");
                                clinicalSet.add(split[0]);
                            }
                        } else {
                            //英文临床试验
                            clinicalSet.addAll(intervention);
                        }
                    } else {
                        //不翻译
                        if (type == 1) {
                            //中文临床试验
                            for (String txt : intervention) {
                                String[] split = txt.split("卐");
                                if (judgeChinese) {
                                    String s = split[0];
                                    if (s.getBytes().length != s.length()) {
                                        clinicalSet.add(s);
                                    }
                                } else {
                                    for (String s : split) {
                                        if (s.getBytes().length == s.length()) {
                                            clinicalSet.add(s);
                                        }
                                    }
                                }
                            }
                        } else {
                            //英文临床试验
                            if (!judgeChinese) {
                                clinicalSet.addAll(intervention);
                            }
                        }

                    }
                }
            }
        }
        //中文上浮（ATC在上）
        List<String> actListZh = new ArrayList<>();
        List<String> actListEn = new ArrayList<>();
        List<String> clinicalListZh = new ArrayList<>();
        List<String> clinicalListEn = new ArrayList<>();
        for (String txt : actSet) {
            if (txt.getBytes().length != txt.length()){
                actListZh.add(txt.toLowerCase());
            }else {
                actListEn.add(txt.toLowerCase());
            }
        }

        clinicalSet = clinicalSet.stream().filter(str -> !clear(str)).collect(Collectors.toSet());
        for (String txt : clinicalSet) {
            if (txt.getBytes().length != txt.length()){
                clinicalListZh.add(txt.toLowerCase());
            }else {
                clinicalListEn.add(txt.toLowerCase());
            }
        }
        List<String> list = new ArrayList<>();
        list.addAll(actListZh);
        list.addAll(actListEn);
        list.addAll(clinicalListZh);
        list.addAll(clinicalListEn);
        if (StringUtils.isNotBlank(search)){
            List<String> afterList = new ArrayList<>();
            search = search.toLowerCase();
            for (String txt : list) {
                if (txt.contains(search)){
                    txt = txt.replaceAll(search, "<span>" + search + "</span>");
                    afterList.add(txt);
                }
            }
            list = afterList;
        }
        PageVo<String> page = new PageVo<>();
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        long total = list.size();
        page.setTotal(total);
        //开始计算每页内容
        List<String> pageList = new ArrayList<>();
        if (total > 0) {
            if ((long) pageSize * pageNum > total) {
                pageList.addAll(list.subList((pageNum - 1) * pageSize, (int) total));
            } else {
                pageList.addAll(list.subList((pageNum - 1) * pageSize, pageNum * pageSize));
            }
        }
        page.setList(pageList);
        page.setPages((int) (total % pageSize == 0 ? total / pageSize : total / pageSize + 1));
        return page;
    }

    private static boolean clear(String input) {
        // 正则表达式匹配除了字母、数字、-和/之外的所有字符
        Matcher matcher = Pattern.compile("[^a-zA-Z0-9-/]").matcher(input);
        boolean b = matcher.find();
        return b;
    }

    @Override
    public PageVo<String> outcome(OutcomeRequest outcomeRequest) {
        Integer isTranslate = outcomeRequest.getIsTranslate();
        Integer pageSize = outcomeRequest.getPageSize();
        Integer pageNum = outcomeRequest.getPageNum();
        String search = outcomeRequest.getSearch();
        List<Disease> diseases = outcomeRequest.getDiseases();
        List<Drug> drugs = outcomeRequest.getDrugs();
        
        List<String> drugRealSearch = new ArrayList<>();
        List<String> diseaseRealSearch = new ArrayList<>();

        for (int i = 0; i < drugs.size(); i++) {
            Drug drug = drugs.get(i);
            Integer status = drug.getStatus();
            if (status == 3){
                i++;
                continue;
            }
            if (status == 2){
                continue;
            }
            String word = drug.getWord();
            List<WordStatus> zhSynonym = drug.getZhSynonym();
            String zhName = drug.getZhWord();
            List<WordStatus> enSynonym = drug.getEnSynonym();
            String enName = drug.getEnWord();
            String expandSynonym = drug.getExpandSynonym();
            if (CollUtil.isNotEmpty(zhSynonym)){
                for (WordStatus wordStatus : zhSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        drugRealSearch.add(name);
                    }
                }
            }
            if (CollUtil.isNotEmpty(enSynonym)){
                for (WordStatus wordStatus : enSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        drugRealSearch.add(name);
                    }
                }
            }
            List<WordStatus> otherSynonym = drug.getOtherSynonym();
            if (CollUtil.isNotEmpty(otherSynonym)){
                for (WordStatus wordStatus : otherSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked) {
                        drugRealSearch.add(name);
                    }
                }
            }
            if (StringUtils.isNotBlank(zhName)){
                drugRealSearch.add(zhName);
            }
            if (StringUtils.isNotBlank(enName)){
                drugRealSearch.add(enName);
            }
            if (StringUtils.isNotBlank(expandSynonym)){
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] split = expandSynonym.split(";");
                drugRealSearch.addAll(Arrays.asList(split));
            }
        }

        for (int i = 0; i < diseases.size(); i++) {
            Disease disease = diseases.get(i);
            Integer status = disease.getStatus();
            if (status == 3){
                i++;
                continue;
            }
            if (status == 2){
                continue;
            }
            Integer diseaseType = disease.getType();
            if (diseaseType == 2){
                continue;
            }
            String word = disease.getWord();
            List<WordStatus> zhSynonym = disease.getZhSynonym();
            String zhName = disease.getZhWord();
            List<WordStatus> enSynonym = disease.getEnSynonym();
            String enName = disease.getEnWord();
            String expandSynonym = disease.getExpandSynonym();
            if (CollUtil.isNotEmpty(zhSynonym)){
                for (WordStatus wordStatus : zhSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        diseaseRealSearch.add(name);
                    }
                }
            }
            if (CollUtil.isNotEmpty(enSynonym)){
                for (WordStatus wordStatus : enSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        diseaseRealSearch.add(name);
                    }
                }
            }
            List<WordStatus> otherSynonym = disease.getOtherSynonym();
            if (CollUtil.isNotEmpty(otherSynonym)){
                for (WordStatus wordStatus : otherSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked) {
                        diseaseRealSearch.add(name);
                    }
                }
            }
            if (StringUtils.isNotBlank(zhName)){
                diseaseRealSearch.add(zhName);
            }
            if (StringUtils.isNotBlank(enName)){
                diseaseRealSearch.add(enName);
            }
            if (StringUtils.isNotBlank(expandSynonym)){
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] split = expandSynonym.split(";");
                diseaseRealSearch.addAll(Arrays.asList(split));
            }
        }
        
        //结局指标
        Set<String> outcomeSet = new HashSet<>();
        for (int i = 0; i < diseases.size(); i++) {
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            if (CollUtil.isNotEmpty(drugRealSearch)) {
                for (String s : drugRealSearch) {
                    MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("intervention", s);
                    matchQueryBuilder.operator(Operator.AND);
                    boolQueryBuilder.should().add(matchQueryBuilder);
                }
            }
            
            if (CollUtil.isNotEmpty(diseaseRealSearch)) {
                for (String s : diseaseRealSearch) {
                    MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("conditions", s);
                    matchQueryBuilder.operator(Operator.AND);
                    boolQueryBuilder.should().add(matchQueryBuilder);
                }
            }
            
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
            nativeSearchQuery.setTrackTotalHits(true);
            long count = elasticsearchRestTemplate.count(nativeSearchQuery, EvidenceClinicalTrials.class);
            List<EvidenceClinicalTrials> indexList = new ArrayList<>();
            if (count > 300){
                count = 300;
            }
            if (count > 0) {
                nativeSearchQuery.setPageable(PageRequest.of(0, (int) count));
                SearchHits<EvidenceClinicalTrials> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, EvidenceClinicalTrials.class);
                for (SearchHit<EvidenceClinicalTrials> searchHit : searchHits) {
                    indexList.add(searchHit.getContent());
                }
                for (EvidenceClinicalTrials evidenceClinicalTrials : indexList) {
                    List<String> outcome = evidenceClinicalTrials.getOutcome();
                    Integer type = evidenceClinicalTrials.getType();
                    if (type == 1) {
                        //中文临床试验
                        for (String txt : outcome) {
                            String[] split = txt.split("卐");
                            if (isTranslate == 1) {
                                outcomeSet.add(split[0]);
                            } else {
                                if (split.length == 2) outcomeSet.add(split[1]);
                            }
                        }
                    } else {
                        //英文临床试验
                        outcomeSet.addAll(outcome);
                    }
                }
            }
        }
        //中文上浮
        List<String> outcomeListZh = new ArrayList<>();
        List<String> outcomeListEn = new ArrayList<>();
        for (String txt : outcomeSet) {
            if (txt.getBytes().length != txt.length()){
                outcomeListZh.add(txt.toLowerCase());
            }else {
                outcomeListEn.add(txt.toLowerCase());
            }
        }
        List<String> list = new ArrayList<>();
        list.addAll(outcomeListZh);
        list.addAll(outcomeListEn);
        list = list.stream().filter(str -> !clear(str)).collect(Collectors.toList());
        if (StringUtils.isNotBlank(search)){
            List<String> afterList = new ArrayList<>();
            search = search.toLowerCase();
            for (String txt : list) {
                if (txt.contains(search)){
                    txt = txt.replaceAll(search, "<span>" + search + "</span>");
                    afterList.add(txt);
                }
            }
            list = afterList;
        }
        PageVo<String> page = new PageVo<>();
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        long total = list.size();
        page.setTotal(total);
        //开始计算每页内容
        List<String> pageList = new ArrayList<>();
        if (total > 0) {
            if ((long) pageSize * pageNum > total) {
                pageList.addAll(list.subList((pageNum - 1) * pageSize, (int) total));
            } else {
                pageList.addAll(list.subList((pageNum - 1) * pageSize, pageNum * pageSize));
            }
        }
        page.setList(pageList);
        page.setPages((int) (total % pageSize == 0 ? total / pageSize : total / pageSize + 1));
        return page;
    }

    @Override
    public Condition echo(String id) {
        return mongoTemplate.findById(id, Condition.class);
    }

    @Override
    public void confirmLGYear(LGYearRequest lgYearRequest) {
        String id = lgYearRequest.getId();
        if (StrUtil.isNotBlank(id)) {
            Condition condition = mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), Condition.class);
            if (Objects.nonNull(condition)) {
                BeanUtils.copyProperties(lgYearRequest, condition);
                mongoTemplate.remove(new Query(Criteria.where("_id").is(id)), Condition.class);
                mongoTemplate.insert(condition);
            }
        }
    }

    @Override
    public JSONObject acquireStatus(String id, long userId) {
        boolean literatureIncludeStatus = false;
        boolean guideIncludeStatus = false;
        JSONObject result = new JSONObject();
        if (StrUtil.isNotBlank(id)) {
            Condition condition = mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), Condition.class);
            if (Objects.nonNull(condition)) {
                List<PaperIncludeOrExclude> includeList = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);
                if (CollUtil.isNotEmpty(includeList)) {
                    literatureIncludeStatus = true;
                }

                List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(1)), GuideIncludeOrExclude.class);
                if (CollUtil.isNotEmpty(guideIncludeOrExcludes)) {
                    guideIncludeStatus = true;
                }
            }
        }
        result.put("literatureIncludeStatus", literatureIncludeStatus);
        result.put("guideIncludeStatus", guideIncludeStatus);
        return result;
    }

    @Override
    public String searchMode(String condition, String originalWord, String range, String word) {
        String resultMode = "";
        if (StrUtil.isNotBlank(range) && StrUtil.isNotBlank(word)) {
            StringBuilder newMode = new StringBuilder();
            if (word.contains("&")) {
                List<String> splitWord = StrUtil.split(word, "&");
                for (String symbol : splitWord) {
                    newMode.append(symbol).append("[").append(range).append("]").append(" : ");
                }
                newMode.replace(newMode.length() - 3, newMode.length(), "");
            } else {
                newMode = new StringBuilder("(" + word + "[" + range + "])");
            }
            if (StrUtil.isNotBlank(condition) && StrUtil.isNotBlank(originalWord)) {
//                String verifyModeStr = verifyMode(originalWord);
//                if (verifyModeStr.contains("<")) {
//                    return verifyModeStr;
//                } 
                resultMode = "("+ originalWord +" " + condition + " "+ newMode +")";
            } else {
                resultMode += newMode;
            }
        }   
        return resultMode;
    }

    @Override
    public String verifyMode(String model) {
        if (!validate(model)) {
            throw new BusinessException(ExceptionEnum.MODEL_FORMAT_ERROR);
        }
        return "";
    }

    @Override
    public JSONObject search(String id, long userId) {
        List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), GuideIncludeOrExclude.class);
        List<CdeIncludeOrExclude> cdeIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), CdeIncludeOrExclude.class);
        List<HtaIncludeOrExclude> htaIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), HtaIncludeOrExclude.class);
        JSONObject result = new JSONObject();
        result.put("guide", guideIncludeOrExcludes.size());
        result.put("cde", cdeIncludeOrExcludes.size());
        result.put("hta", htaIncludeOrExcludes.size());
        return result;
    }

    @Override
    public JSONObject basketTypeSearch(String condition, long userId, HttpServletRequest request) {
        String question = "请作为医学文献分析专家，从输入文本精准提取PICO四要素。仅提取文本明确存在的内容；缺失留空。文本限定于医学治疗方案（药品/手术/医疗器械）针对疾病的临床研究表述。\n" +
                "\n" +
                "**核心定义（100%保留原始文本片段，禁止添加/删减字词）**：  \n" +
                "- p：疾病状态及治疗需求描述（如\"结直肠癌根治术\"），保留所有修饰（分期/手术类型）  \n" +
                "- i：治疗手段的纯名词描述（如\"腹腔镜手术\"），**排除所有动词**（\"治疗\"/\"用于\"等）  \n" +
                "- c：显性（\"相比\"后）或隐性（\"常规\"修饰）的对比方案  \n" +
                "- o：具体疗效/安全性指标（如\"5年生存率\"）  \n" +
                "\n" +
                "**必须执行的切割规则**：  \n" +
                "1. **动词强制隔离**：  \n" +
                "   - 动词（\"治疗\"/\"实施\"）**仅作分割符，不纳入任何要素**  \n" +
                "   - 示例：  \n" +
                "     `\"腹腔镜手术治疗肝癌\"` → `i:\"腹腔镜手术\"`, `p:\"肝癌\"`  \n" +
                "     `\"实施达芬奇机器人手术的胃癌\"` → `i:\"达芬奇机器人手术\"`, `p:\"胃癌\"`  \n" +
                "2. **术语完整性**：  \n" +
                "   - 手术/器械名称整体保留（错误：i:\"腹腔镜\" → 正确：i:\"腹腔镜手术\"）  \n" +
                "   - p必须含完整修饰（错误：p:\"结直肠癌\" → 正确：p:\"结直肠癌根治术\"）  \n" +
                "3. **验证要求**：  \n" +
                "   - p必须为疾病描述（通过ICD-10验证存在性）  \n" +
                "   - i必须为无动词的纯名词（通过MedDRA验证）  \n" +
                "\n" +
                "**输入文本**：{"+ condition +"}  \n" +
                "\n" +
                "**输出要求**：  \n" +
                "1. JSON格式：`p`, `i`, `c`, `o`  \n" +
                "2. 多值用中文顿号分隔  \n" +
                "3. 空字段`\"\"`  \n" +
                "4. **零添加原则**：  \n" +
                "   - p仅提取疾病文本（如\"肝癌\"，非\"肝癌患者\"）  \n" +
                "   - 保留所有原始修饰（\"III期\"、\"根治术\"、\"达芬奇Xi系统\"）  \n";

        String resultAs = AIRequestUtils.modelStudio(question, Constants.QWEN3_MAX_2025_09_23);
        if (StrUtil.isNotBlank(resultAs)) {
            try {
                int start = resultAs.indexOf('{');
                int end = resultAs.lastIndexOf('}');
                Gson gson = new Gson();
                Type guideListType = new TypeToken<HomePage>(){}.getType();
                HomePage homePage = gson.fromJson(resultAs.substring(start, end + 1), guideListType);
                if (Objects.nonNull(homePage)) {
                    ConditionRequest conditionRequest = new ConditionRequest();
                    conditionRequest.setId("");
                    conditionRequest.setGuideStartYear("不限");
                    conditionRequest.setGuideEndYear("至今");
                    conditionRequest.setLiteratureStartYear("不限");
                    conditionRequest.setLiteratureEndYear("至今");

                    conditionRequest.setDrugs(processStringToList(homePage.getI(), (word, index) -> {
                        if (index > 0) {
                            Drug separator = new Drug();
                            separator.setStatus(2);
                            return Arrays.asList(separator, createDrugItem(word));
                        }
                        return Collections.singletonList(createDrugItem(word));
                    }));
                    
                    conditionRequest.setDiseases(processStringToList(homePage.getP(), (word, index) -> {
                        if (index > 0) {
                            Disease separator = new Disease();
                            separator.setStatus(2);
                            return Arrays.asList(separator, createDiseaseItem(word));
                        }
                        return Collections.singletonList(createDiseaseItem(word));
                    }));
                    
                    conditionRequest.setInterventions(processStringToList(homePage.getC(), (word, index) -> {
                        if (index > 0) {
                            InterventionAndOutcome cOrO = new InterventionAndOutcome();
                            cOrO.setStatus(2);
                            return Arrays.asList(cOrO, createCOrOItem(word, 3));
                        }
                        return Collections.singletonList(createCOrOItem(word, 3));
                    }));

                    conditionRequest.setOutcomes(processStringToList(homePage.getO(), (word, index) -> {
                        if (index > 0) {
                            InterventionAndOutcome cOrO = new InterventionAndOutcome();
                            cOrO.setStatus(2);
                            return Arrays.asList(cOrO, createCOrOItem(word, 4));
                        }
                        return Collections.singletonList(createCOrOItem(word, 4));
                    }));

                    return saveCondition(conditionRequest, userId, request);
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
        return new JSONObject();
    }

    @Override
    public JSONObject personal(String token, long userId) {
        String userInfo = systemFeign.userInfo();

        JSONObject res = JSON.parseObject(userInfo, JSONObject.class);
        if (res.getInteger("code") == 200) {
            return res.getJSONObject("data");
        }
        return new JSONObject();
    }

    private Drug createDrugItem(String word) {
        Drug drug = new Drug();
        drug.setWord(word);
        drug.setStatus(1);
        JSONObject synonym = synonym(word, 1, 1);
        SynonymGenerateAdapter.buildSynonymByDrug(synonym, drug);
        return drug;
    }

    private Disease createDiseaseItem(String word) {
        Disease disease = new Disease();
        disease.setWord(word);
        disease.setStatus(1);
        JSONObject synonym = synonym(word, 2, 1);
        SynonymGenerateAdapter.buildSynonymByDisease(synonym, disease);
        return disease;
    }

    private InterventionAndOutcome createCOrOItem(String word, Integer range) {
        InterventionAndOutcome cOrO = new InterventionAndOutcome();
        cOrO.setWord(word);
        cOrO.setStatus(1);
        JSONObject synonym = synonym(word, range, 1);
        SynonymGenerateAdapter.buildSynonymByCOrO(synonym, cOrO);
        return cOrO;
    }
    
    private <T> List<T> processStringToList(String input, BiFunction<String, Integer, List<T>> processor) {
        if (StrUtil.isBlank(input) || "空".equals(input)) {
            return Collections.emptyList();
        }

        return Arrays.stream(input.split("、"))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(ArrayList::new,
                        (list, item) -> list.addAll(processor.apply(item, list.size())),
                        ArrayList::addAll);
    }


    public static boolean validate(String expression) {
        // 检查1：括号必须成对且正确嵌套
        if (!checkParentheses(expression)) {
            return false;
        }
        
        // 检查2：所有逻辑运算符（AND/OR/NOT）必须使用正确
        if (!checkLogicalOperators(expression)) {
            return false;
        }
        
        // 检查3：所有内容单元必须符合格式 "内容[关键词]"
        return checkContentUnits(expression);
    }

    // 辅助方法1：验证括号是否成对且正确嵌套
    private static boolean checkParentheses(String expression) {
        Stack<Character> stack = new Stack<>();
        for (char c : expression.toCharArray()) {
            if (c == '(') {
                stack.push(c);
            } else if (c == ')') {
                if (stack.isEmpty() || stack.pop() != '(') {
                    return false; // 括号不匹配
                }
            }
        }
        return stack.isEmpty(); // 栈空说明括号成对
    }

    // 辅助方法2：验证逻辑运算符是否合法
    private static boolean checkLogicalOperators(String expression) {
        // 用正则表达式验证运算符的合法性
        String regex = "(?i)(NOT\\s*\\$[^)]+$|(\\$[^)]+\\$(\\s*(AND|OR|NOT)\\s*\\$[^)]+\\$)+))";
        String noSpacesExpr = expression.replaceAll("\\s+", ""); // 去掉所有空格

        // 检查是否包含非法运算符（如小写）
        if (Pattern.compile("(and|or|not)").matcher(noSpacesExpr).find()) {
            return false;
        }

        // 检查连续运算符（如 AND AND）
        if (noSpacesExpr.matches(".*(AND|OR|NOT)(AND|OR|NOT).*")) {
            return false;
        }

        // 检查开头或结尾是运算符
        if (noSpacesExpr.startsWith("AND") || noSpacesExpr.startsWith("OR")
                || noSpacesExpr.endsWith("AND") || noSpacesExpr.endsWith("OR")) {
            return false;
        }

        return true;
    }

    // 辅助方法3：验证所有内容单元格式
    private static boolean checkContentUnits(String expression) {
        expression = "("+expression+")";
        // 匹配所有形如 (xxx[yyy]) 的单元
//        Pattern pattern = Pattern.compile("/^([^\\[\\]]+\\[[^\\[\\]]+\\])/$");
        Pattern pattern = Pattern.compile("\\(([^\\[\\]]+\\[[^\\[\\]]+\\])\\)");
        Matcher matcher = pattern.matcher(expression.replaceAll("\\s+", ""));

        // 统计所有能匹配的合法单元数量
        int validUnitCount = 0;
        while (matcher.find()) {
            validUnitCount++;
            String unit = matcher.group(1);
            if (!unit.matches(".+\\[.+\\]")) { // 进一步验证格式
                return false;
            }
        }

        // 至少需要有一个合法单元
        return validUnitCount > 0;
    }


    @Override
    public JSONObject saveCondition(ConditionRequest conditionRequest, Long userId, HttpServletRequest request) {
        // 确认 获取到同义词
        lastAssembleConditon(conditionRequest);
        
        JSONObject result = new JSONObject();
        
        String id;
        String dtoId = conditionRequest.getId();
        if (StringUtils.isNotBlank(dtoId)){
            mongoTemplate.remove(new Query(Criteria.where("_id").is(dtoId)), Condition.class);
            id = dtoId;
        }else {
            id = UUID.randomUUID().toString();
        }
        
        Condition condition = new Condition();
        
        // 转换信息确认页面的期刊 时间
        transformDataFormat(conditionRequest);

        BeanUtils.copyProperties(conditionRequest, condition);
        condition.setId(id);
        condition.setUserId(userId);
        long epochMilli = Instant.now().toEpochMilli();
        condition.setTimeStamp(epochMilli);
        
        // 数据补全
        dataCompletion(condition);

        ExecutorService executorService = Executors.newFixedThreadPool(1);

        CompletableFuture<Void> decoFuture = CompletableFuture.runAsync(() -> {
            aiService.deconWords(condition);
        }, executorService);

        CompletableFuture<Void> allFuture = CompletableFuture.allOf(decoFuture);
        allFuture.join();
        executorService.shutdown();
        try {
            if (!executorService.awaitTermination(30, TimeUnit.SECONDS)) {
                executorService.shutdownNow();
            }
        } catch (InterruptedException e) {
            executorService.shutdownNow();
            Thread.currentThread().interrupt();
        }
        
        try {
            mongoTemplate.save(condition);
        } catch (Exception e) {
           log.error(e.getMessage(), e);
            throw new RuntimeException(id + "存储异常");
        }
        //判断是否为新建课题
        Question question = mongoTemplate.findById(id, Question.class);
        if (question == null){
            String info = questionService.create(id, userId, request);
            result.put("info", info);
        }else {
            //修改操作时间
            question.setUpdateTime(epochMilli);
        }
        result.put("id", id);
        return result;
    }

    private void handleSynonym(ConditionRequest conditionRequest) {
        List<Drug> drugs = conditionRequest.getDrugs();
        if (CollUtil.isNotEmpty(drugs)) {
            for (Drug drug : drugs) {
                Set<String> uniquePhrases = new HashSet<>();
                Map<String, String> originalPhrases = new HashMap<>();
                
                List<WordStatus> zhSynonym = drug.getZhSynonym();
                zhSynonym = zhSynonym.stream().filter(WordStatus::getChecked).filter(wordStatus -> {
                    String phrase = wordStatus.getName();
                    String normalizedPhrase = normalize(phrase);
                    if (!uniquePhrases.contains(normalizedPhrase)) {
                        uniquePhrases.add(normalizedPhrase);
                        originalPhrases.put(normalizedPhrase, phrase);
                        return true;
                    }
                    return false;
                }).collect(Collectors.toList());
                drug.setZhSynonym(zhSynonym);
                
                List<WordStatus> enSynonym = drug.getEnSynonym();
                enSynonym = enSynonym.stream().filter(WordStatus::getChecked).filter(wordStatus -> {
                    String phrase = wordStatus.getName();
                    String normalizedPhrase = normalize(phrase);
                    if (!uniquePhrases.contains(normalizedPhrase)) {
                        uniquePhrases.add(normalizedPhrase);
                        originalPhrases.put(normalizedPhrase, phrase);
                        return true;
                    }
                    return false;
                }).collect(Collectors.toList());
                drug.setEnSynonym(enSynonym);
                
                List<WordStatus> otherSynonym = drug.getOtherSynonym();
                otherSynonym = otherSynonym.stream().filter(WordStatus::getChecked).filter(wordStatus -> {
                    String phrase = wordStatus.getName();
                    String normalizedPhrase = normalize(phrase);
                    if (!uniquePhrases.contains(normalizedPhrase)) {
                        uniquePhrases.add(normalizedPhrase);
                        originalPhrases.put(normalizedPhrase, phrase);
                        return true;
                    }
                    return false;
                }).collect(Collectors.toList());
                drug.setOtherSynonym(otherSynonym);
            }
        }

        List<Disease> diseases = conditionRequest.getDiseases();
        if (CollUtil.isNotEmpty(diseases)) {
            for (Disease disease : diseases) {
                Set<String> uniquePhrases = new HashSet<>();
                Map<String, String> originalPhrases = new HashMap<>();
                
                List<WordStatus> zhSynonym = disease.getZhSynonym();
                zhSynonym = zhSynonym.stream().filter(WordStatus::getChecked).filter(wordStatus -> {
                    String phrase = wordStatus.getName();
                    String normalizedPhrase = normalize(phrase);
                    if (!uniquePhrases.contains(normalizedPhrase)) {
                        uniquePhrases.add(normalizedPhrase);
                        originalPhrases.put(normalizedPhrase, phrase);
                        return true;
                    }
                    return false;
                }).collect(Collectors.toList());
                disease.setZhSynonym(zhSynonym);

                List<WordStatus> enSynonym = disease.getEnSynonym();
               
                enSynonym = enSynonym.stream().filter(WordStatus::getChecked).filter(wordStatus -> {
                    String phrase = wordStatus.getName();
                    String normalizedPhrase = normalize(phrase);
                    if (!uniquePhrases.contains(normalizedPhrase)) {
                        uniquePhrases.add(normalizedPhrase);
                        originalPhrases.put(normalizedPhrase, phrase);
                        return true;
                    }
                    return false;
                }).collect(Collectors.toList());
                disease.setEnSynonym(enSynonym);

                List<WordStatus> otherSynonym = disease.getOtherSynonym();
                otherSynonym = otherSynonym.stream().filter(WordStatus::getChecked).filter(wordStatus -> {
                    String phrase = wordStatus.getName();
                    String normalizedPhrase = normalize(phrase);
                    if (!uniquePhrases.contains(normalizedPhrase)) {
                        uniquePhrases.add(normalizedPhrase);
                        originalPhrases.put(normalizedPhrase, phrase);
                        return true;
                    }
                    return false;
                }).collect(Collectors.toList());
                disease.setOtherSynonym(otherSynonym);
            }
        }
    }

    private String normalize(String phrase) {
        // Remove special characters and split by spaces
        String[] words = phrase.replaceAll("[^a-zA-Z0-9\\u4e00-\\u9fff\\s]", "").split("\\s+");
        // Sort the words
        Arrays.sort(words);
        // Join the words back into a single string
        return String.join(" ", words);
    }

    @Override
    public void dataCompletion(BaseCondition condition) {
        List<Drug> drugs = condition.getDrugs();
        if (CollUtil.isNotEmpty(drugs)) {
            for (Drug drug : drugs) {
                Integer status = drug.getStatus();
                if (status == 1) {
                    // 补全商品名 和 中英文同义词
                    searchCommodityName(condition, drug, drugs);
                }
            }
        }
        // 整理 药品 和 疾病需要回显的数据
        echoGuide(condition);
        echoLiterature(condition);
    }

    private void echoLiterature(BaseCondition condition) {
        PaperPICOConditionDTO paperPICOCondition = new PaperPICOConditionDTO();
        condition.getDrugs().forEach(drug -> {
            List<WordStatus> enSynonym = drug.getEnSynonym();
            List<WordStatus> otherSynonym = drug.getOtherSynonym();
            List<WordStatus> zhSynonym = drug.getZhSynonym();
            zhSynonym.addAll(enSynonym);
            zhSynonym.addAll(otherSynonym);
            drug.setZhSynonym(zhSynonym);
        });
        paperPICOCondition.setDrugs(condition.getDrugs());
        paperPICOCondition.setDiseases(condition.getDiseases());
        paperPICOCondition.setInterventions(condition.getInterventions());
        paperPICOCondition.setOutcomes(condition.getOutcomes());
        paperPICOCondition.setStudyType(condition.getStudyType());
        paperPICOCondition.setIsTranslate(condition.getIsTranslate());
        condition.setPaperPICOConditionDTO(paperPICOCondition);
    }


    private void echoGuide(BaseCondition condition) {
        String echoData = "";
        AtomicBoolean retain = new AtomicBoolean(true);
        List<Drug> drugs = condition.getDrugs();
        if (CollUtil.isNotEmpty(drugs)) {
            echoData = drugs.stream().filter(drug -> {
                Integer status = drug.getStatus();
                if (status == 1 && retain.get()) {
                    return true;
                }
                if (status == 2) {
                    retain.set(true);
                }
                if (status == 3) {
                    retain.set(false);
                }
                return false;
            }).map(Drug::getWord).collect(Collectors.joining(";"));
        }
        List<Disease> diseases = condition.getDiseases();
        if (CollUtil.isNotEmpty(diseases)) {
            if (StrUtil.isNotBlank(echoData)) {
                echoData += ";";
            }
            echoData += diseases.stream().filter(drug -> {
                Integer status = drug.getStatus();
                if (status == 1 && retain.get()) {
                    return true;
                }
                if (status == 2) {
                    retain.set(true);
                }
                if (status == 3) {
                    retain.set(false);
                }
                return false;
            }).map(Disease::getWord).collect(Collectors.joining(";"));
        }
        condition.setGuideEchoData(echoData);
    }

    private void searchCommodityName(BaseCondition condition, Drug drug, List<Drug> drugs) {
        List<String> commodityNames = new ArrayList<>();
        
        String drugName = drug.getWord().toLowerCase();
        if (StrUtil.isNotBlank(drugName)) {
            // 利用es 查询 中英文对应的翻译词
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            boolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", drugName));  // 药品名称
            boolQueryBuilder.should().add(QueryBuilders.termQuery("drugName.keyword", drugName)); // 同义词 五级中英文
            boolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", drugName));  // 商品名
            boolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", drugName));  // 商品名
            boolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", drugName));  // 药品中文
            boolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", drugName));  // 药品英文
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
            SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, DrugAndIndicationIndex.class);
            if (Objects.nonNull(drugAndIndicationIndexSearchHit)) {
                DrugAndIndicationIndex drugInfo = drugAndIndicationIndexSearchHit.getContent();
                List<String> zhDrugNames = drugInfo.getZhDrugNames();
                List<String> enDrugNames = drugInfo.getEnDrugNames();
                drug.setZhDrugNames(zhDrugNames.stream().filter(StrUtil::isNotBlank).collect(Collectors.toList()));
                drug.setEnDrugNames(enDrugNames.stream().filter(StrUtil::isNotBlank).collect(Collectors.toList()));
            }
        }

        String enWord = drug.getEnWord().toLowerCase();
        String zhWord = drug.getZhWord().toLowerCase();
        // 增加商品名作为检索条件 
        BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
        orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("zhDrugName.keyword", zhWord, enWord));  // 药品名称
        orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("drugName.keyword", zhWord, enWord)); // 同义词 五级中英文
        orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("commodityNameZh.keyword", zhWord, enWord));  // 商品名
        orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("commodityNameEn.keyword", zhWord, enWord));  // 商品名
        orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("drugZh.keyword", zhWord, enWord));  // 药品中文
        orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("drugEn.keyword", zhWord, enWord));  // 药品英文
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(orBoolQueryBuilder);
        SearchHits<DrugAndIndicationIndex> searchZh = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
        List<SearchHit<DrugAndIndicationIndex>> searchHits = searchZh.getSearchHits();
        if (CollUtil.isNotEmpty(searchHits)) {
            searchHits.stream().map(SearchHit::getContent).forEach(drugAndIndicationIndex -> {
                String commodityNameEn = drugAndIndicationIndex.getCommodityNameEn();
                String commodityNameZh = drugAndIndicationIndex.getCommodityNameZh();
                if (StrUtil.isNotBlank(commodityNameZh)) {
                    commodityNames.add(commodityNameZh);
                }
                if (StrUtil.isNotBlank(commodityNameEn)) {
                    commodityNames.add(commodityNameEn);
                }
            });
        }
        drug.setCommodityNames(commodityNames.stream().distinct().collect(Collectors.toList()));
        condition.setDrugs(drugs);
    }


    private void transformDataFormat(ConditionRequest conditionRequest) {
        String guideStartYear = conditionRequest.getGuideStartYear();
        if (StrUtil.isNotBlank(guideStartYear) && "不限".equals(guideStartYear)) {
            conditionRequest.setGuideStartYear("1000");
        }
        String guideEndYear = conditionRequest.getGuideEndYear();
        if (StrUtil.isNotBlank(guideEndYear) && "至今".equals(guideEndYear)) {
            int year = LocalDate.now().getYear();
            conditionRequest.setGuideEndYear(year+"");
        }

        String literatureStartYear = conditionRequest.getLiteratureStartYear();
        if (StrUtil.isNotBlank(literatureStartYear) && "不限".equals(literatureStartYear)) {
            conditionRequest.setLiteratureStartYear("1000");
            conditionRequest.setSelfLiteratureStartYear("不限");
        }
        String literatureEndYear = conditionRequest.getLiteratureEndYear();
        if (StrUtil.isNotBlank(literatureEndYear) && "至今".equals(literatureEndYear)) {
            int year = LocalDate.now().getYear();
            conditionRequest.setLiteratureEndYear(year+"");
            conditionRequest.setSelfLiteratureEndYear("至今");
        }
        
        if ("至今".equals(conditionRequest.getSelfLiteratureEndYear()) && "不限".equals(conditionRequest.getSelfLiteratureStartYear())) {
            conditionRequest.setSelfLiteratureYear(true);
        }
        
        List<String> zhJournal = conditionRequest.getZhJournal();
        if (CollUtil.isNotEmpty(zhJournal) && "不限".equals(zhJournal.get(0))) {
            List<String> zhJournalList = Arrays.asList("北大核心", "CSCD", "科技核心", "南大核心");
            conditionRequest.setZhJournal(zhJournalList);
        }

        List<String> enJournal = conditionRequest.getEnJournal();
        if (CollUtil.isNotEmpty(enJournal)) {
            if ("不限".equals(enJournal.get(0))) {
                List<String> enJournalList = Arrays.asList("JCR(Q1)", "JCR(Q2)", "JCR(Q3)", "JCR(Q4)", "JCR(Q5)");
                conditionRequest.setEnJournal(enJournalList);
            } else {
                enJournal =  enJournal.stream().map(journal -> {
                    if (journal.contains("N/A")) {
                        int left = journal.indexOf("(");
                        int right = journal.indexOf(")");
                        String level = journal.substring(left + 1, right);
                        return journal.replace("N/A", "Q5");
                    } else {
                        return journal;
                    }
                }).collect(Collectors.toList());
                conditionRequest.setEnJournal(enJournal);
            }
        }
    }

    private void lastAssembleConditon(ConditionRequest conditionRequest) {
        if (Objects.isNull(conditionRequest)) {
            return;
        }
        List<Drug> drugs = conditionRequest.getDrugs();
        if (CollUtil.isNotEmpty(drugs)) {
            for (Drug drug : drugs) {
                if (drug.getStatus() == 1 
                        && (StrUtil.isBlank(drug.getEnWord()) 
                                || StrUtil.isBlank(drug.getZhWord()) 
                                || (!StrUtil.equals(drug.getWord(), drug.getZhWord()) && !StrUtil.equals(drug.getWord(), drug.getEnWord())))) {
                    // 获取同义词
                    JSONObject synonym = synonym(drug.getWord(), 1, conditionRequest.getIsTranslate());
                    if (Objects.nonNull(synonym)) {
                        JSONObject enSynonym = synonym.getJSONObject("en");
                        if (Objects.nonNull(enSynonym)) {
                            String enName = enSynonym.getString("name");
                            List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> drugWordStatusEn = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListEn)) {
                                synonymListEn.forEach((str) -> {
                                    drugWordStatusEn.add(new WordStatus(str, true));
                                });
                            }
                            drug.setEnWord(enName);
                            drug.setEnSynonym(drugWordStatusEn);
                        }

                        JSONObject zhSynonym = synonym.getJSONObject("zh");
                        if (Objects.nonNull(zhSynonym)) {
                            String zhName = zhSynonym.getString("name");
                            List<String> synonymListZh = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> drugWordStatusZh = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListZh)) {
                                synonymListZh.forEach((str) -> {
                                    drugWordStatusZh.add(new WordStatus(str, true));
                                });
                            }
                            drug.setZhWord(zhName);
                            drug.setZhSynonym(drugWordStatusZh);
                        }

                        JSONObject otherSynonym = synonym.getJSONObject("other");
                        if (Objects.nonNull(otherSynonym)) {
                            List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> drugWordStatusOther = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListOther)) {
                                synonymListOther.forEach((str) -> {
                                    drugWordStatusOther.add(new WordStatus(str, true));
                                });
                            }
                            drug.setOtherSynonym(drugWordStatusOther);
                        }
                    }
                }
            }
        }

        List<Disease> diseases = conditionRequest.getDiseases();
        if (CollUtil.isNotEmpty(diseases)) {
            for (Disease disease : diseases) {
                if (disease.getStatus() == 1 
                        && (StrUtil.isBlank(disease.getEnWord()) 
                        || StrUtil.isBlank(disease.getZhWord())
                        || (!StrUtil.equals(disease.getWord(), disease.getZhWord()) && !StrUtil.equals(disease.getWord(), disease.getEnWord())))) {
                    
                    JSONObject synonym = synonym(disease.getWord(), 2, conditionRequest.getIsTranslate());
                    if (Objects.nonNull(synonym)) {
                        JSONObject enSynonym = synonym.getJSONObject("en");
                        if (Objects.nonNull(enSynonym)) {
                            String enName = enSynonym.getString("name");
                            List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> diseaseWordStatusEn = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListEn)) {
                                synonymListEn.forEach((str) -> {
                                    diseaseWordStatusEn.add(new WordStatus(str, true));
                                });
                            }
                            disease.setEnWord(enName);
                            disease.setEnSynonym(diseaseWordStatusEn);
                        }

                        JSONObject zhSynonym = synonym.getJSONObject("zh");
                        if (Objects.nonNull(zhSynonym)) {
                            String zhName = zhSynonym.getString("name");
                            List<String> synonymListZh = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> diseaseWordStatusZh = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListZh)) {
                                synonymListZh.forEach((str) -> {
                                    diseaseWordStatusZh.add(new WordStatus(str, true));
                                });
                            }
                            disease.setZhWord(zhName);
                            disease.setZhSynonym(diseaseWordStatusZh);
                        }
                        
                        JSONObject otherSynonym = synonym.getJSONObject("other");
                        if (Objects.nonNull(otherSynonym)) {
                            List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(otherSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> diseaseWordStatusOther = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListOther)) {
                                synonymListOther.forEach((str) -> {
                                    diseaseWordStatusOther.add(new WordStatus(str, true));
                                });
                            }
                            disease.setOtherSynonym(diseaseWordStatusOther);
                        }
                    }
                }
            }
        }

        List<InterventionAndOutcome> interventions = conditionRequest.getInterventions();
        if (CollUtil.isNotEmpty(interventions)) {
            for (InterventionAndOutcome intervention : interventions) {
                if (intervention.getStatus() == 1 
                        && (StrUtil.isBlank(intervention.getEnWord()) 
                        || StrUtil.isBlank(intervention.getZhWord())
                        || (!StrUtil.equals(intervention.getWord(), intervention.getZhWord()) && !StrUtil.equals(intervention.getWord(), intervention.getEnWord())))) {
                    
                    JSONObject synonym = synonym(intervention.getWord(), 3, conditionRequest.getIsTranslate());
                    if (Objects.nonNull(synonym)) {
                        JSONObject enSynonym = synonym.getJSONObject("en");
                        if (Objects.nonNull(enSynonym)) {
                            String enName = enSynonym.getString("name");
                            List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            List<WordStatus> interventionWordStatusEn = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListEn)) {
                                synonymListEn.forEach((str) -> {
                                    interventionWordStatusEn.add(new WordStatus(str, true));
                                });
                            }
                            intervention.setEnWord(enName);
                            intervention.setEnSynonym(interventionWordStatusEn);
                        }

                        JSONObject zhSynonym = synonym.getJSONObject("zh");
                        if (Objects.nonNull(zhSynonym)) {
                            String zhName = zhSynonym.getString("name");
                            List<String> synonymListZh = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            List<WordStatus> interventionWordStatusZh = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListZh)) {
                                synonymListZh.forEach((str) -> {
                                    interventionWordStatusZh.add(new WordStatus(str, true));
                                });
                            }
                            intervention.setZhWord(zhName);
                            intervention.setZhSynonym(interventionWordStatusZh);
                        }

                        JSONObject otherSynonym = synonym.getJSONObject("other");
                        if (Objects.nonNull(otherSynonym)) {
                            List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(otherSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> diseaseWordStatusOther = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListOther)) {
                                synonymListOther.forEach((str) -> {
                                    diseaseWordStatusOther.add(new WordStatus(str, true));
                                });
                            }
                            intervention.setOtherSynonym(diseaseWordStatusOther);
                        }
                    }
                }
            }
        }

        List<InterventionAndOutcome> outcomes = conditionRequest.getOutcomes();
        if (CollUtil.isNotEmpty(outcomes)) {
            for (InterventionAndOutcome outcome : outcomes) {
                if (outcome.getStatus() == 1 
                        && (StrUtil.isBlank(outcome.getEnWord()) 
                        || StrUtil.isBlank(outcome.getZhWord())
                        || (!StrUtil.equals(outcome.getWord(), outcome.getZhWord()) && !StrUtil.equals(outcome.getWord(), outcome.getEnWord())))) {
                    JSONObject synonym = synonym(outcome.getWord(), 4, conditionRequest.getIsTranslate());
                    if (Objects.nonNull(synonym)) {
                        JSONObject enSynonym = synonym.getJSONObject("en");
                        if (Objects.nonNull(enSynonym)) {
                            String enName = enSynonym.getString("name");
                            List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            List<WordStatus> outcomeWordStatusEn = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListEn)) {
                                synonymListEn.forEach((str) -> {
                                    outcomeWordStatusEn.add(new WordStatus(str, true));
                                });
                            }
                            outcome.setEnWord(enName);
                            outcome.setEnSynonym(outcomeWordStatusEn);
                        }

                        JSONObject zhSynonym = synonym.getJSONObject("zh");
                        if (Objects.nonNull(zhSynonym)) {
                            String zhName = zhSynonym.getString("name");
                            List<String> synonymListZh = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            List<WordStatus> outcomeWordStatusZh = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListZh)){
                                synonymListZh.forEach((str) -> {
                                    outcomeWordStatusZh.add(new WordStatus(str, true));
                                });
                            }
                            outcome.setZhWord(zhName);
                            outcome.setZhSynonym(outcomeWordStatusZh);
                        }

                        JSONObject otherSynonym = synonym.getJSONObject("other");
                        if (Objects.nonNull(otherSynonym)) {
                            List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(otherSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> diseaseWordStatusOther = new ArrayList<>();
                            if (CollUtil.isNotEmpty(synonymListOther)) {
                                synonymListOther.forEach((str) -> {
                                    diseaseWordStatusOther.add(new WordStatus(str, true));
                                });
                            }
                            outcome.setOtherSynonym(diseaseWordStatusOther);
                        }
                    }
                }
            }
        }
    }

}

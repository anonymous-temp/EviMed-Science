package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.date.DateUtil;
import cn.hutool.core.map.MapUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.feign.ManageFeign;
import com.sentum.evidencecomprehensive.feign.SystemFeign;
import com.sentum.evidencecomprehensive.pojo.bo.es.DrugAndIndicationIndex;
import com.sentum.evidencecomprehensive.pojo.bo.es.EvidenceClinicalTrials;
import com.sentum.evidencecomprehensive.pojo.bo.es.GuideIndex;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.*;
import com.sentum.evidencecomprehensive.pojo.dto.*;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.pojo.info.WordStatus;
import com.sentum.evidencecomprehensive.pojo.vo.GuideConfirmVo;
import com.sentum.evidencecomprehensive.pojo.vo.LiteratureConfirmVo;
import com.sentum.evidencecomprehensive.pojo.vo.LiteratureGuideVo;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;
import com.sentum.evidencecomprehensive.service.*;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import com.sentum.evidencecomprehensive.utils.SynonymUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang.StringUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.elasticsearch.index.query.*;
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
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
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
    private ManageFeign manageFeign;
    @Autowired
    private FineScreenFeign fineScreenFeign;
    @Autowired
    private PaperService paperService;
    @Autowired
    private AISearchLGService aiSearchLGService;
    @Autowired
    private GuideService guideService;
    @Autowired
    private SystemFeign systemFeign;

    @Override
    public JSONObject acquireLiteratureGuide(String id, long userId) {
        JSONObject result = new JSONObject();
        Date includeLastBegin = new Date();
        
        LiteratureGuideVo literatureGuideVo = new LiteratureGuideVo();
        
        List<GuideConfirmVo> guides = new ArrayList<>();
        List<LiteratureConfirmVo> papers = new ArrayList<>();

//        LiteratureGuideVo literatureGuide = mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), LiteratureGuideVo.class, "evaluation_literatureGuideConfirm");
        
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.nonNull(condition)) {
            ExecutorService executorService = Executors.newFixedThreadPool(2);
            
            CompletableFuture<Void> guideAsync = CompletableFuture.runAsync(() -> {
                List<JSONObject> guideList = new ArrayList<>();
                
                // 
                Map<String, String> includeLatest = guideService.includeLatest(id, userId);

                if (MapUtil.isNotEmpty(includeLatest)) {
                    for (Map.Entry<String, String> entry : includeLatest.entrySet()) {
                        String guideId = entry.getKey();
                        String block = entry.getValue();
                        
                        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
                        boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(guideId));
                        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
                        SearchHit<GuideIndex> guideIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, GuideIndex.class);
                        if (Objects.nonNull(guideIndexSearchHit)) {
                            JSONObject innerGuide = new JSONObject();
                            GuideConfirmVo guideConfirmVo = new GuideConfirmVo();

                            GuideIndex guide = guideIndexSearchHit.getContent();

                            innerGuide.put("id", guide.getId());
                            guideConfirmVo.setId(guide.getId());

                            String title = guide.getTitle();
                            guideConfirmVo.setTitle(title);
                            String zdzType = guide.getZdzType();
                            if (StringUtils.isNotBlank(zdzType)) {
                                title += "-" + zdzType;
                            }

                            String fbdate = guide.getFbdate();
                            guideConfirmVo.setFbdate(fbdate);
                            if (StringUtils.isNotBlank(fbdate)) {
                                title += "-" + fbdate;
                            }
                            innerGuide.put("title", title);
                            innerGuide.put("zdz", guide.getZdz());
                            guideConfirmVo.setZdz(zdzType);
                            guideConfirmVo.setOrganization(zdzType);
                            innerGuide.put("blocks", block);
                            guideConfirmVo.setBlocks(block);
                            innerGuide.put("year", guide.getYsar());
                            guideConfirmVo.setYear(guide.getYsar());
                            innerGuide.put("isPaper", guide.getIsPaper());
                            guideConfirmVo.setIsPaper(guide.getIsPaper());
                            innerGuide.put("cc", guide.getCc());
                            guideList.add(innerGuide);
                            guides.add(guideConfirmVo);
                        }
                    }
                }
                result.put("guide", guideList);
            }, executorService);

            CompletableFuture<Void> literatureAsync = CompletableFuture.runAsync(() -> {
                paperService.includeLatest(id, userId);
                
                List<JSONObject> literatureList = new ArrayList<>();
                
                List<PaperIncludeOrExclude> paperIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);
                for (PaperIncludeOrExclude paperIncludeOrExclude : paperIncludeOrExcludes) {
                    MongoLiterature mongoLiterature = null;
                    try {
                        mongoLiterature = fineScreenFeign.paper(paperIncludeOrExclude.getPaperId());
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                    if (mongoLiterature != null) {
                        JSONObject innerLiterature = new JSONObject();
                        LiteratureConfirmVo literatureConfirmVo = new LiteratureConfirmVo();
                        
                        innerLiterature.put("id", mongoLiterature.getId());
                        innerLiterature.put("title", mongoLiterature.getTitle());
                        innerLiterature.put("summary", mongoLiterature.getSummary());
                        innerLiterature.put("year", mongoLiterature.getYear());

                        literatureConfirmVo.setId(mongoLiterature.getId());
                        literatureConfirmVo.setTitle(mongoLiterature.getTitle());
                        literatureConfirmVo.setSummary(mongoLiterature.getSummary());

                        String fullJournal = mongoLiterature.getFullJournal();
                        if (StringUtils.isNotBlank(fullJournal)) {
                            innerLiterature.put("journal",fullJournal);
                            literatureConfirmVo.setJournal(fullJournal);
                        } else {
                            String journal = mongoLiterature.getJournal();
                            if (StringUtils.isNotBlank(journal)) {
                                innerLiterature.put("journal",journal);
                                literatureConfirmVo.setJournal(journal);
                            } else {
                                innerLiterature.put("journal","");
                            }
                        }

                        List<Integer> lastNewType = mongoLiterature.getLastNewType();
                        StringBuilder studyTypeBuilder = new StringBuilder();
                        if (CollectionUtils.isNotEmpty(lastNewType)) {
                            for (Integer type : lastNewType) {
                                switch (type) {
                                    case 0:
                                        studyTypeBuilder.append("系统综述/Meta分析、");
                                        continue;
                                    case 1:
                                        studyTypeBuilder.append("传统综述、");
                                        continue;
                                    case 2:
                                        studyTypeBuilder.append("随机对照试验、");
                                        continue;
                                    case 3:
                                        studyTypeBuilder.append("队列研究、");
                                        continue;
                                    case 4:
                                        studyTypeBuilder.append("病例对照研究、");
                                        continue;
                                    case 5:
                                        studyTypeBuilder.append("横断面研究、");
                                        continue;
                                    case 6:
                                        studyTypeBuilder.append("病例系列、");
                                        continue;
                                    case 7:
                                        studyTypeBuilder.append("病例报告、");
                                        continue;
                                    case 8:
                                        studyTypeBuilder.append("专家意见和评价、");
                                        continue;
                                    case 9:
                                        studyTypeBuilder.append("动物实验、");
                                        continue;
                                    case 10:
                                        studyTypeBuilder.append("体外实验、");
                                        continue;
                                    case 11:
                                        studyTypeBuilder.append("指南/共识、");
                                        continue;
                                    case 13:
                                        studyTypeBuilder.append("其他、");
                                        continue;
                                    case 14:
                                        studyTypeBuilder.append("临床试验、");
                                        continue;
                                    default:
                                        break;
                                }
                            }
                            if (CollectionUtils.isNotEmpty(mongoLiterature.getType())) {
                                for (Integer type : mongoLiterature.getType()) {
                                    if (type == 7) {
                                        studyTypeBuilder.append("临床试验、");
                                    }
                                }
                            }
                        } else {
                            studyTypeBuilder.append(" ");
                        }
                        String studyTypeName = studyTypeBuilder.toString();
                        if (StringUtils.isNotBlank(studyTypeName)) {
                            studyTypeName = studyTypeName.substring(0, studyTypeName.length() - 1);
                        }
                        innerLiterature.put("type", studyTypeName);
                        literatureConfirmVo.setType(studyTypeName);
                        String customType = mongoLiterature.getCustomType();
                        if (StringUtils.isNotBlank(customType)) {
                            innerLiterature.put("type", customType);
                        }

                        Double jcr = mongoLiterature.getJcr();
                        if (Objects.nonNull(jcr)) {
                            innerLiterature.put("jcr", jcr);
                            literatureConfirmVo.setJcr(jcr);
                        }
                        literatureList.add(innerLiterature);
                        papers.add(literatureConfirmVo);
                    }
                }
                result.put("literature", literatureList);
            }, executorService);
            
            // 等待所有任务完成
            CompletableFuture<Void> allFutures = CompletableFuture.allOf(guideAsync, literatureAsync);
            
            allFutures.join();

            log.info("指南 and 文献 was {} second for inclusion.", (new Date().getTime() - includeLastBegin.getTime()) / 1000);
            executorService.shutdown();
            try {
                if (!executorService.awaitTermination(30, TimeUnit.SECONDS)) {
                    executorService.shutdownNow();
                }
            } catch (InterruptedException e) {
                executorService.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }
        
        literatureGuideVo.setId(id);
        literatureGuideVo.setGuideConfirmVo(guides);
        literatureGuideVo.setLiteratureConfirmVo(papers);
        editLiteratureGuide(literatureGuideVo, 0L);
        return result;
    }

    @Override
    public void editLiteratureGuide(LiteratureGuideVo literatureGuideVo, long userId) {
        // 保存 编辑实体
        mongoTemplate.save(literatureGuideVo, "evaluation_literatureGuideConfirm");
    }

    @Override
    public JSONArray typeList() {
        JSONArray result = new JSONArray();
        List<Integer> typeList = Arrays.asList(0, 1, 2, 14, 3, 4, 5, 6, 7, 8, 11, 9, 10, 13);
        List<String> nameList = Arrays.asList("系统综述/Meta分析", "传统综述", "随机对照试验", "临床试验", "队列研究", "病例对照研究", "横断面研究", "病例系列", "病例报告", "专家意见和评价", "指南/共识", "动物实验", "体外实验", "其他");
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

    @Override
    public String innerSynonym(String str) {
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
    
    @Override
    public void confirmLGYear(LGYearDto lgYearDto) {
        String id = lgYearDto.getId();
        if (StringUtils.isNotBlank(id)) {
            Condition condition = mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), Condition.class);
            if (Objects.nonNull(condition)) {
                BeanUtils.copyProperties(lgYearDto, condition);
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
        if (StringUtils.isNotBlank(id)) {
            Condition condition = mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), Condition.class);
            if (Objects.nonNull(condition)) {
                List<PaperIncludeOrExclude> includeList = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);
                if (CollectionUtils.isNotEmpty(includeList)) {
                    literatureIncludeStatus = true;
                }

                List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(1)), GuideIncludeOrExclude.class);
                if (CollectionUtils.isNotEmpty(guideIncludeOrExcludes)) {
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
        if (StringUtils.isNotBlank(range) && StringUtils.isNotBlank(word)) {
            StringBuilder newMode = new StringBuilder();
            if (word.contains("&")) {
                List<String> splitWord = StrUtil.split(word, "&");
                for (String symbol : splitWord) {
                    newMode.append(symbol).append("[").append(range).append("]").append(" : ");
                }
                newMode.replace(newMode.length() - 3, newMode.length(), "");
            } else {
                newMode = new StringBuilder(word + "[" + range + "]");
            }
            if (StringUtils.isNotBlank(condition) && StringUtils.isNotBlank(originalWord)) {
//                String verifyModeStr = verifyMode(originalWord);
//                if (verifyModeStr.contains("<")) {
//                    return verifyModeStr;
//                } 
                resultMode = "("+ originalWord +") " + condition + " ("+ newMode +")";
            } else {
                resultMode += newMode;
            }
        }
        return resultMode;
    }

    @Override
    public JSONObject search(String id, long userId) {
        List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), GuideIncludeOrExclude.class);
        List<CdeIncludeOrExclude> cdeIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), CdeIncludeOrExclude.class);
        List<HtaIncludeOrExclude> htaIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), HtaIncludeOrExclude.class);
        JSONObject result = new JSONObject();
        
        result.put("guide", guideIncludeOrExcludes.stream().map(GuideIncludeOrExclude::getGuideId).distinct().count());
//        result.put("cde", cdeIncludeOrExcludes.stream().distinct().collect(Collectors.toSet()));
//        result.put("hta", htaIncludeOrExcludes.stream().distinct().collect(Collectors.toSet()));
        return result;
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

    @Override
    public Boolean synonymFeedback(SynonymFeedbackDto synonymFeedbackDto, Long userId) {
        SynonymFeedback synonymFeedback = new SynonymFeedback();
        synonymFeedback.setUserId(userId);
        String word = synonymFeedback.getWord();
        List<WordStatus> zhSynonym = synonymFeedbackDto.getZhSynonym();
        List<WordStatus> enSynonym = synonymFeedbackDto.getEnSynonym();
        synonymFeedback.setWord(word);
        synonymFeedback.setZhSynonym(zhSynonym);
        synonymFeedback.setEnSynonym(enSynonym);
        try {
            mongoTemplate.save(synonymFeedback);
            return true;
        } catch (Exception e) {
            e.printStackTrace();
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
            SearchHits<DrugAndIndicationIndex> search2 = elasticsearchRestTemplate.search(new NativeSearchQuery(multiMatchBuilder), DrugAndIndicationIndex.class);
            if (search2.getTotalHits() > 0){
                for (SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit : search2) {
                    DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
                    String realDosageForm = content.getDosageForm();
                    dosageForm.add(realDosageForm);
                }
            }
        }
        result.getJSONArray("name").addAll(name);
        result.getJSONArray("dosageForm").addAll(dosageForm);
        return result;
    }

    @Override
    public PageVo<String> disease(DrugDto drugDto) {
        Integer isTranslate = drugDto.getIsTranslate();
        Integer pageSize = drugDto.getPageSize();
        Integer pageNum = drugDto.getPageNum();
        String search = drugDto.getSearch();
        List<Drug> drugDtoDrugs = drugDto.getDrugs();
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
//            if (CollectionUtils.isNotEmpty(zhSynonym)){
//                for (WordStatus wordStatus : zhSynonym) {
//                    String name = wordStatus.getName();
//                    Boolean checked = wordStatus.getChecked();
//                    if (checked){
//                        searchWord.add(name);
//                    }
//                }
//            }
//            if (CollectionUtils.isNotEmpty(enSynonym)){
//                for (WordStatus wordStatus : enSynonym) {
//                    String name = wordStatus.getName();
//                    Boolean checked = wordStatus.getChecked();
//                    if (checked){
//                        searchWord.add(name);
//                    }
//                }
//            }
//            List<WordStatus> otherSynonym = drug.getOtherSynonym();
//            if (CollectionUtils.isNotEmpty(otherSynonym)){
//                for (WordStatus wordStatus : otherSynonym) {
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
                        if (CollectionUtils.isNotEmpty(diseaseZh)) {
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
                        if (CollectionUtils.isNotEmpty(disease)) {
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
    public PageVo<String> icd10(DrugDto drugDto) {
        Integer isTranslate = drugDto.getIsTranslate();
        Integer pageSize = drugDto.getPageSize();
        Integer pageNum = drugDto.getPageNum();
        String search = drugDto.getSearch();
        List<String> drugs = new ArrayList<>();
        List<Drug> drugDtoDrugs = drugDto.getDrugs();
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
        long total = mongoTemplate.count(query, Icd11.class);
        query.with(PageRequest.of(pageNum - 1, pageSize));
        List<Icd11> icd11s = mongoTemplate.find(query, Icd11.class);
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
    public PageVo<String> referenceDrug(DrugDto drugDto) {
        Integer isTranslate = drugDto.getIsTranslate();
        Integer pageSize = drugDto.getPageSize();
        Integer pageNum = drugDto.getPageNum();
        String search = drugDto.getSearch();
        List<Drug> drugDtoDrugs = drugDto.getDrugs();
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
            if (CollectionUtils.isNotEmpty(zhSynonym)){
                for (WordStatus wordStatus : zhSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        realSearch.add(name);
                    }
                }
            }
            if (CollectionUtils.isNotEmpty(enSynonym)){
                for (WordStatus wordStatus : enSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        realSearch.add(name);
                    }
                }
            }
            List<WordStatus> otherSynonym = drug.getOtherSynonym();
            if (CollectionUtils.isNotEmpty(otherSynonym)) {
                for (WordStatus wordStatus : otherSynonym) {
                    if (wordStatus.getChecked()) {
                        realSearch.add(wordStatus.getName());
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
                        if (CollectionUtils.isNotEmpty(drugNames)){
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
                        if (CollectionUtils.isNotEmpty(drugNames)){
                            for (String drugName : drugNames) {
                                level5.add(drugName.toLowerCase());
                            }
                        }
                    }
                }
                if (CollectionUtils.isNotEmpty(level5)){
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
    private boolean clear(String input) {
        // 正则表达式匹配除了字母、数字、-和/之外的所有字符
        Matcher matcher = Pattern.compile("[^a-zA-Z0-9-/]").matcher(input);
        return matcher.find();
    }

    @Override
    public PageVo<String> outcome(OutcomeDto outcomeDto) {
        Integer isTranslate = outcomeDto.getIsTranslate();
        Integer pageSize = outcomeDto.getPageSize();
        Integer pageNum = outcomeDto.getPageNum();
        String search = outcomeDto.getSearch();
        List<Disease> diseases = outcomeDto.getDiseases();
        List<Drug> drugs = outcomeDto.getDrugs();

        List<String> drugRealSearch = new ArrayList<>();
        List<String> diseaseRealSearch = new ArrayList<>();
        boolean judgeChinese = false;
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
            judgeChinese = word.getBytes().length != word.length();
            List<WordStatus> zhSynonym = drug.getZhSynonym();
            String zhName = drug.getZhWord();
            List<WordStatus> enSynonym = drug.getEnSynonym();
            String enName = drug.getEnWord();
            String expandSynonym = drug.getExpandSynonym();
            if (CollectionUtils.isNotEmpty(zhSynonym)){
                for (WordStatus wordStatus : zhSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        drugRealSearch.add(name);
                    }
                }
            }
            if (CollectionUtils.isNotEmpty(enSynonym)){
                for (WordStatus wordStatus : enSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        drugRealSearch.add(name);
                    }
                }
            }
            List<WordStatus> otherSynonym = drug.getOtherSynonym();
            if (CollectionUtils.isNotEmpty(otherSynonym)) {
                for (WordStatus wordStatus : otherSynonym) {
                    if (wordStatus.getChecked()) {
                        drugRealSearch.add(wordStatus.getName());
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
            if (CollectionUtils.isNotEmpty(zhSynonym)){
                for (WordStatus wordStatus : zhSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
                        diseaseRealSearch.add(name);
                    }
                }
            }
            if (CollectionUtils.isNotEmpty(enSynonym)){
                for (WordStatus wordStatus : enSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked){
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
            if (CollectionUtils.isNotEmpty(drugRealSearch)) {
                BoolQueryBuilder interventionBool = QueryBuilders.boolQuery();
                for (String s : drugRealSearch) {
                    MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("intervention", s);
                    matchQueryBuilder.operator(Operator.AND);
                    interventionBool.should().add(matchQueryBuilder);
                }
                boolQueryBuilder.must().add(interventionBool);
            }
            if (CollectionUtils.isNotEmpty(diseaseRealSearch)) {
                BoolQueryBuilder conditions = QueryBuilders.boolQuery();
                for (String s : diseaseRealSearch) {
                    MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("conditions", s);
                    matchQueryBuilder.operator(Operator.AND);
                    conditions.should().add(matchQueryBuilder);
                }
                boolQueryBuilder.must().add(conditions);
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

                    // 需要翻译解决指标  中英文
                    if (isTranslate == 1) {
                        if (type == 1) {
                            //中文临床试验
                            for (int i1 = 0; i1 < outcome.size(); i1++) {
                                String txt = outcome.get(i1);
                                String[] split = txt.split("卐");
                                outcomeSet.add(split[0]);
                                try {
                                    if (StringUtils.isNotBlank(split[1])) {
                                        outcomeSet.add(split[1]);
                                    }
                                } catch (Exception e) {
                                    log.error("结局指标数组位置获取失败！");
                                }
                            }
                        } else {
                            //英文临床试验
                            outcomeSet.addAll(outcome);
                        }
                    } else {
                        if (type == 1) {
                            //中文临床试验
                            for (int i1 = 0; i1 < outcome.size(); i1++) {
                                String txt = outcome.get(i1);
                                String[] split = txt.split("卐");
                                if (judgeChinese) {
                                    String s = split[0];
                                    if (s.getBytes().length != s.length()) {
                                        outcomeSet.add(s);
                                    }
                                } else {
                                    for (String s : split) {
                                        if (s.getBytes().length == s.length()) {
                                            outcomeSet.add(s);
                                        }
                                    }
                                }
                            }
                        } else {
                            //英文临床试验
                            if (!judgeChinese) {
                                outcomeSet.addAll(outcome);
                            }
                        }
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
    public JSONObject saveCondition(ConditionDto conditionDto, Long userId, HttpServletRequest request) {
        // 做同义词获取的最后一层校验组装
        lastAssembleConditon(conditionDto);

        JSONObject result = new JSONObject();

        //唯一id
        String id;
        //判断当前课题id是否存在，存在进行覆盖操作
        String dtoId = conditionDto.getId();
        if (StringUtils.isNotBlank(dtoId)){
            mongoTemplate.remove(new Query(Criteria.where("_id").is(dtoId)), Condition.class);
            id = dtoId;
        }else {
            id = UUID.randomUUID().toString();
        }

        Condition condition = new Condition();

        transformDataFormat(conditionDto);

        BeanUtils.copyProperties(conditionDto, condition);
        condition.setId(id);
        condition.setUserId(userId);
        long timeMillis = System.currentTimeMillis();
        condition.setTimeStamp(timeMillis);

        // 补全五级同义词 商品名 
        commoditySynonymCompletion(condition);

        ExecutorService executorService = Executors.newFixedThreadPool(2);
//        CompletableFuture<Void> expandedFuture = CompletableFuture.runAsync(() -> {
//            aiSearchLGService.expandedWords(condition);
//        }, executorService);

        CompletableFuture<Void> decoFuture = CompletableFuture.runAsync(() -> {
            aiSearchLGService.deconWords(condition);
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
            log.error("保存 课题 出现错误 {}", e.getMessage(), e);
            throw new RuntimeException(id + "存储异常");
        }
        //判断是否为新建课题
        Question question = mongoTemplate.findById(id, Question.class);
        if (question == null){
            String info = questionService.create(id, userId, request);
            result.put("info", info);
        }else {
            //修改操作时间
            question.setUpdateTime(timeMillis);
        }
        result.put("id", id);
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "超说明书");
            dataJson.put("module", "药学");
            dataJson.put("report_name", result.getString("info"));
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        }catch (Exception e){
            log.error("超说明书添加机构汇总异常" + e.getMessage(), e);
        }
        return result;
    }

    private void transformDataFormat(ConditionDto conditionDto) {
        String guideStartYear = conditionDto.getGuideStartYear();
        if (StringUtils.isNotBlank(guideStartYear) && "不限".equals(guideStartYear)) {
            conditionDto.setGuideStartYear("1000");
        }
        String guideEndYear = conditionDto.getGuideEndYear();
        if (StringUtils.isNotBlank(guideEndYear) && "至今".equals(guideEndYear)) {
            int year = LocalDate.now().getYear();
            conditionDto.setGuideEndYear(year+"");
        }

        String literatureStartYear = conditionDto.getLiteratureStartYear();
        if (StringUtils.isNotBlank(literatureStartYear) && "不限".equals(literatureStartYear)) {
            conditionDto.setLiteratureStartYear("1000");
        }
        String literatureEndYear = conditionDto.getLiteratureEndYear();
        if (StringUtils.isNotBlank(literatureEndYear) && "至今".equals(literatureEndYear)) {
            int year = LocalDate.now().getYear();
            conditionDto.setLiteratureEndYear(year+"");
        }

        List<String> zhJournal = conditionDto.getZhJournal();
        if (CollectionUtils.isNotEmpty(zhJournal) && "不限".equals(zhJournal.get(0))) {
            List<String> zhJournalList = Arrays.asList("北大核心", "CSCD", "科技核心", "南大核心");
            conditionDto.setZhJournal(zhJournalList);
        }

        List<String> enJournal = conditionDto.getEnJournal();
        if (CollectionUtils.isNotEmpty(enJournal)) {
            if ("不限".equals(enJournal.get(0))) {
                List<String> enJournalList = Arrays.asList("JCR(Q1)", "JCR(Q2)", "JCR(Q3)", "JCR(Q4)", "JCR(Q5)");
                conditionDto.setEnJournal(enJournalList);
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
                conditionDto.setEnJournal(enJournal);
            }
        }
    }

    private void lastAssembleConditon(ConditionDto conditionDto) {
        if (Objects.isNull(conditionDto)) {
            return;
        }
        List<Drug> drugs = conditionDto.getDrugs();
        if (CollectionUtils.isNotEmpty(drugs)) {
            for (Drug drug : drugs) {
                if (drug.getStatus() == 1 && (StrUtil.isBlank(drug.getEnWord()) || StrUtil.isBlank(drug.getZhWord()))) {
                    JSONObject synonym = synonym(drug.getWord(), 1, conditionDto.getIsTranslate());
                    if (Objects.nonNull(synonym)) {
                        JSONObject enSynonym = synonym.getJSONObject("en");
                        if (Objects.nonNull(enSynonym)) {
                            String enName = enSynonym.getString("name");
                            List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> drugWordStatusEn = new ArrayList<>();
                            if (CollectionUtils.isNotEmpty(synonymListEn)) {
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
                            if (CollectionUtils.isNotEmpty(synonymListZh)) {
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
                            if (CollectionUtils.isNotEmpty(synonymListOther)) {
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

        List<Disease> diseases = conditionDto.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            for (Disease disease : diseases) {
                if (disease.getStatus() == 1 && (StrUtil.isBlank(disease.getEnWord()) || StrUtil.isBlank(disease.getZhWord()))) {
                    JSONObject synonym = synonym(disease.getWord(), 2, conditionDto.getIsTranslate());
                    if (Objects.nonNull(synonym)) {
                        JSONObject enSynonym = synonym.getJSONObject("en");
                        if (Objects.nonNull(enSynonym)) {
                            String enName = enSynonym.getString("name");
                            List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> diseaseWordStatusEn = new ArrayList<>();
                            if (CollectionUtils.isNotEmpty(synonymListEn)) {
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
                            if (CollectionUtils.isNotEmpty(synonymListZh)) {
                                synonymListZh.forEach((str) -> {
                                    diseaseWordStatusZh.add(new WordStatus(str, true));
                                });
                            }
                            disease.setZhWord(zhName);
                            disease.setZhSynonym(diseaseWordStatusZh);
                        }

                        JSONObject otherSynonym = synonym.getJSONObject("other");
                        if (Objects.nonNull(otherSynonym)) {
                            List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> drugWordStatusOther = new ArrayList<>();
                            if (CollectionUtils.isNotEmpty(synonymListOther)) {
                                synonymListOther.forEach((str) -> {
                                    drugWordStatusOther.add(new WordStatus(str, true));
                                });
                            }
                            disease.setOtherSynonym(drugWordStatusOther);
                        }
                    }
                }
            }
        }

        List<InterventionAndOutcome> interventions = conditionDto.getInterventions();
        if (CollectionUtils.isNotEmpty(interventions)) {
            for (InterventionAndOutcome intervention : interventions) {
                if (intervention.getStatus() == 1 && (StrUtil.isBlank(intervention.getEnWord()) || StrUtil.isBlank(intervention.getZhWord()))) {
                    JSONObject synonym = synonym(intervention.getWord(), 3, conditionDto.getIsTranslate());
                    if (Objects.nonNull(synonym)) {
                        JSONObject enSynonym = synonym.getJSONObject("en");
                        if (Objects.nonNull(enSynonym)) {
                            String enName = enSynonym.getString("name");
                            List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            List<WordStatus> interventionWordStatusEn = new ArrayList<>();
                            if (CollectionUtils.isNotEmpty(synonymListEn)) {
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
                            if (CollectionUtils.isNotEmpty(synonymListZh)) {
                                synonymListZh.forEach((str) -> {
                                    interventionWordStatusZh.add(new WordStatus(str, true));
                                });
                            }
                            intervention.setZhWord(zhName);
                            intervention.setZhSynonym(interventionWordStatusZh);
                        }

                        JSONObject otherSynonym = synonym.getJSONObject("other");
                        if (Objects.nonNull(otherSynonym)) {
                            List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> drugWordStatusOther = new ArrayList<>();
                            if (CollectionUtils.isNotEmpty(synonymListOther)) {
                                synonymListOther.forEach((str) -> {
                                    drugWordStatusOther.add(new WordStatus(str, true));
                                });
                            }
                            intervention.setOtherSynonym(drugWordStatusOther);
                        }
                    }
                }
            }
        }

        List<InterventionAndOutcome> outcomes = conditionDto.getOutcomes();
        if (CollectionUtils.isNotEmpty(outcomes)) {
            for (InterventionAndOutcome outcome : outcomes) {
                if (outcome.getStatus() == 1 && (StrUtil.isBlank(outcome.getEnWord()) || StrUtil.isBlank(outcome.getZhWord()))) {
                    JSONObject synonym = synonym(outcome.getWord(), 4, conditionDto.getIsTranslate());
                    if (Objects.nonNull(synonym)) {
                        JSONObject enSynonym = synonym.getJSONObject("en");
                        if (Objects.nonNull(enSynonym)) {
                            String enName = enSynonym.getString("name");
                            List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            List<WordStatus> outcomeWordStatusEn = new ArrayList<>();
                            if (CollectionUtils.isNotEmpty(synonymListEn)) {
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
                            if (CollectionUtils.isNotEmpty(synonymListZh)){
                                synonymListZh.forEach((str) -> {
                                    outcomeWordStatusZh.add(new WordStatus(str, true));
                                });
                            }
                            outcome.setZhWord(zhName);
                            outcome.setZhSynonym(outcomeWordStatusZh);
                        }

                        JSONObject otherSynonym = synonym.getJSONObject("other");
                        if (Objects.nonNull(otherSynonym)) {
                            List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });

                            List<WordStatus> drugWordStatusOther = new ArrayList<>();
                            if (CollectionUtils.isNotEmpty(synonymListOther)) {
                                synonymListOther.forEach((str) -> {
                                    drugWordStatusOther.add(new WordStatus(str, true));
                                });
                            }
                            outcome.setOtherSynonym(drugWordStatusOther);
                        }
                    }
                }
            }
        }
    }

    private void commoditySynonymCompletion(Condition condition) {
        List<Drug> drugs = condition.getDrugs();
        if (CollectionUtils.isNotEmpty(drugs)) {
            for (Drug drug : drugs) {
                Integer status = drug.getStatus();
                if (status == 1) {
                    List<String> commodityNames = new ArrayList<>();

                    String drugName = drug.getWord().toLowerCase();
                    if (StringUtils.isNotBlank(drugName)) {
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
                    // 增加上商品名作为检索条件 
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
                    if (CollectionUtils.isNotEmpty(searchHits)) {
                        searchHits.stream().map(SearchHit::getContent).forEach(drugAndIndicationIndex -> {
                            String commodityNameEn = drugAndIndicationIndex.getCommodityNameEn();
                            String commodityNameZh = drugAndIndicationIndex.getCommodityNameZh();
                            if (StringUtils.isNotBlank(commodityNameZh)) {
                                commodityNames.add(commodityNameZh);
                            }
                            if (StringUtils.isNotBlank(commodityNameEn)) {
                                commodityNames.add(commodityNameEn);
                            }
                        });
                    }
                    List<String> commodityNamesResult = commodityNames;
                    commodityNamesResult = commodityNamesResult.stream().distinct().collect(Collectors.toList());
                    drug.setCommodityNames(commodityNamesResult);
                    condition.setDrugs(drugs);
                }
            }
        }
    }
}

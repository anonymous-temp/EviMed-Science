package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.map.MapUtil;
import cn.hutool.core.util.RandomUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HtmlUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.auth0.jwt.interfaces.Claim;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.dto.ai.GuideDS;
import com.sentum.evidencecomprehensive.domain.dto.report.CdeWordReport;
import com.sentum.evidencecomprehensive.domain.dto.ExcludeReasonDTO;
import com.sentum.evidencecomprehensive.domain.dto.report.HtaWordReport;
import com.sentum.evidencecomprehensive.domain.dto.*;
import com.sentum.evidencecomprehensive.domain.es.DrugAndIndicationIndex;
import com.sentum.evidencecomprehensive.domain.es.GuideIndex;
import com.sentum.evidencecomprehensive.domain.es.InstructionIndex;
import com.sentum.evidencecomprehensive.domain.es.PaperIndex;
import com.sentum.evidencecomprehensive.domain.mongo.*;
import com.sentum.evidencecomprehensive.domain.mongo.report.EssentialMedicines;
import com.sentum.evidencecomprehensive.domain.mongo.report.Procurement;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.feign.ManageFeign;
import com.sentum.evidencecomprehensive.feign.MedicineFeign;
import com.sentum.evidencecomprehensive.handler.KafkaSender;
import com.sentum.evidencecomprehensive.domain.dto.DrugFormatDataBo;
import com.sentum.evidencecomprehensive.domain.entity.paper.PaperInfo;
import com.sentum.evidencecomprehensive.domain.dto.DrugConditionDTO;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.domain.vo.InitialRequestVo;
import com.sentum.evidencecomprehensive.service.*;
import com.sentum.evidencecomprehensive.utils.QueryUtils;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import com.sentum.evidencecomprehensive.utils.operateyl.CommonUtil;
import com.sentum.evidencecomprehensive.utils.operateyl.DefaultIncludeUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.JwtUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.RedisUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.*;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.elasticsearch.search.aggregations.metrics.ParsedSum;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import javax.servlet.http.HttpServletRequest;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Service
@Slf4j
public class ReportServiceImpl implements ReportService {

    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private AdverseService adverseService;
    @Autowired
    private PaperService paperService;
    @Autowired
    private PaperInfoServiceImpl paperInfoService;
    @Autowired
    private GuideService guideService;
    @Autowired
    private QuestionService questionService;
    @Autowired
    private DefaultIncludeUtils defaultIncludeUtils;
    @Autowired
    private MedicineFeign medicineFeign;
    @Autowired
    private FineScreenFeign fineScreenFeign;
    @Autowired
    private ManageFeign manageFeign;
    @Autowired
    private CdeService cdeService;
    @Autowired
    private KafkaSender kafkaSender;
    @Autowired
    private HtaService htaService;
    @Autowired
    private AiSearchLGServiceImpl aiSearchLGService;
    @Autowired
    private JwtUtils jwtUtils;
    @Autowired
    private DeepSeekService deepSeekService;
    
    @Value("${file.server.hta.pdf.url}")
    private String htaPdfUrl;
    @Value("${file.server.hta.pdf.trans.url}")
    private String transHtaPdfUrl;
    @Value("${download.url}")
    private String downloadUrl;


    public void include(String id, long userId, JSONObject data) {
        if (StrUtil.isNotBlank(id)) {
            Condition condition = mongoTemplate.findById(id, Condition.class);
            if (Objects.nonNull(condition)) {
                try {
                    long firstTime = System.currentTimeMillis();
                    Runnable runPaper = () -> {
                        long startTime = System.currentTimeMillis();
//                        paperService.paperInclude(condition, userId);
                        log.info("文献默认纳入花费时间{}", System.currentTimeMillis() - startTime);
                    };
                    Runnable runGuide = () -> {
                        long startTime = System.currentTimeMillis();
                        secondGenerationInclude(condition, userId, data);
                        log.info("指南默认纳入花费时间{}", System.currentTimeMillis() - startTime);
                    };
                    Runnable runHta = () -> {
                        long startTime = System.currentTimeMillis();
                        htaService.defaultInclusion(id, userId);
                        log.info("hta默认纳入花费时间{}", System.currentTimeMillis() - startTime);
                    };
                    Runnable runGuideDS = () -> {
                        long startTime = System.currentTimeMillis();
                        List<Drug> drugs = condition.getDrugs();
                        String drug = "";
                        if (CollUtil.isNotEmpty(drugs)) {
                            drug = drugs.get(0).getWord();
                        }
                        List<Disease> diseases = condition.getDiseases();
                        String disease = "";
                        if (CollUtil.isNotEmpty(diseases)) {
                            disease = diseases.get(0).getWord();
                        }
                        List<GuideDS> guideDS = deepSeekService.searchGuideTop5(drug, disease);
                        data.put("guideDS", guideDS);
                        log.info("deepSeek spending time on search guide ···· {}", System.currentTimeMillis() - startTime);
                    };  
                    ExecutorService executorService = Executors.newFixedThreadPool(4);
                    executorService.execute(runPaper);
                    executorService.execute(runGuide);
                    executorService.execute(runHta);
                    executorService.execute(runGuideDS);
                    executorService.shutdown();
                    while (!executorService.isTerminated()) {
                        try {
                            Thread.sleep(1000);
                        } catch (InterruptedException e) {
                            log.error(e.getMessage(), e);
                        }
                    }
                    condition.setInclusionSuccess(true);
                    log.info("默认纳入已完成，纳入花费总时间{}", System.currentTimeMillis() - firstTime);
                } catch (Exception e) {
                    condition.setInclusionSuccess(false);
                    log.error("默认纳入出现错误！！！，错误信息{}", e.getMessage(), e);
                } finally {
                    // 更新一下纳入情况
                    mongoTemplate.remove(new Query(Criteria.where("_id").is(id)), Condition.class);
                    mongoTemplate.insert(condition);
                }
            }
        }
    }

    private void secondGenerationInclude(Condition condition, long userId, JSONObject data) {
        Date now = new Date();
        List<Map<String, String>> searchGuide = guideService.secondGenerationInclude(condition);
        log.info("指南纳入，查询指南{}篇,用时{}", searchGuide.size(), new Date().getTime() - now.getTime());
        if (CollUtil.isNotEmpty(searchGuide) && searchGuide.size() > 100) {
            searchGuide = searchGuide.stream().limit(100).collect(Collectors.toList());
        }
        
        Map<String, String> guideTitleToText1 = new HashMap<>();
        List<String> includeIds = new ArrayList<>();
        aiSearchLGService.secondGenerationInclude(condition, searchGuide, guideTitleToText1, includeIds);
        data.put("guideTitleToText1", guideTitleToText1);
        data.put("includeIds", includeIds);
        log.info("指南纳入，最终纳入指南{}篇", includeIds.size());
        
        OperateRequest OperateRequest = new OperateRequest(condition.getId(), new ArrayList<>(includeIds), 1);
        guideService.operate(OperateRequest, userId);
    }

    @Override
    public JSONObject show(String id) {
        if (StrUtil.isNotBlank(id)) {
            JSONObject evidenceBasedReport = mongoTemplate.findById(id, JSONObject.class, "evidence_based_report");
            if (Objects.nonNull(evidenceBasedReport)) {
                Double reportVersion = evidenceBasedReport.getDouble("reportVersion");
                String redisVersion = RedisUtils.getStr(Constants.REPORT_VERSION);
                if (Objects.isNull(reportVersion) || reportVersion < Double.parseDouble(redisVersion)) {
                    evidenceBasedReport.put("reportRefresh", true);
                }  else {
                    evidenceBasedReport.put("reportRefresh", false);
                }
                return evidenceBasedReport;
            }
        }
        return null;
    }

    @Override
    public DataResult getInitialData(InitialRequestVo initialRequestVo, long userId) {
        String id = initialRequestVo.getId();
        if (StrUtil.isBlank(id)) {
            return DataResult.error("系统出现错误1！");
        }
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.isNull(condition)) {
            return DataResult.error("系统出现错误2！");
        }
        boolean confirm = initialRequestVo.isConfirm();
        if (confirm) {
            return DataResult.ok();
        }
        List<Drug> drugs = condition.getDrugs();
        List<InterventionAndOutcome> interventions = condition.getInterventions();
        // and进行连接的Drug对象集合
        List<Drug> drugAnd = new ArrayList<>();
        if (CollUtil.isNotEmpty(drugs)) {
            boolean isRejected = false;
            for (Drug drug : drugs) {
                if (drug.getStatus() == 1) {
                    if (!isRejected) {
                        drugAnd.add(drug);
                    } else {
                        isRejected = false;
                    }
                    continue;
                }
                if (drug.getStatus() == 2) {
                    continue;
                }
                if (drug.getStatus() == 3) {
                    isRejected = true;
                }
            }
        }

        String name = initialRequestVo.getName();
        String drugName = initialRequestVo.getDrugName();
        String commodityName = initialRequestVo.getCommodityName();
        String specification = initialRequestVo.getSpecification();
        String manufacturer = initialRequestVo.getManufacturer();
        String dosage = initialRequestVo.getDosage();
        boolean first = initialRequestVo.isFirst(); // 是否首次进行检索

        JSONArray jsonArray = new JSONArray(); // 返回结果
        if (first) {
            if (CollUtil.isNotEmpty(drugAnd)) {
                for (Drug drug : drugAnd) {
                    String commodityName_first = drug.getCommodityName();
                    String dosage_first = drug.getDosageForm();
                    String drugName_first = drug.getWord();
                    if ("剂型".equals(dosage_first)) dosage_first = ""; // 这里是前端的问题 初始传 剂型两个字
                    if (StrUtil.isBlank(drugName_first)) continue; // 输入词为空直接跳过
                    // 存储用户最新的说明书检索条件
                    String conditionDrugName = Constants.EVIDENCE_ZTE_REPORT_CONDITION_KEY + id + ":" + drugName_first;
                    DrugConditionDTO drugConditionDTO = new DrugConditionDTO(drugName_first, "", commodityName_first, dosage_first, "", "");
                    RedisUtils.set(conditionDrugName, drugConditionDTO);
                    // 进行聚合
                    JSONObject jsonObject_aa = getJSONObject_aa(drugName_first, "", commodityName_first, "", dosage_first, "", first);
                    jsonArray.add(jsonObject_aa);
                }
            }
            if (CollUtil.isNotEmpty(interventions)) {
                for (InterventionAndOutcome intervention : interventions) {
                    String drugName_first = intervention.getWord();
                    if (StrUtil.isBlank(drugName_first)) continue; // 输入词为空直接跳过
                    // 存储用户最新的说明书检索条件
                    String conditionDrugName = Constants.EVIDENCE_ZTE_REPORT_CONDITION_KEY + id + ":" + drugName_first;
                    DrugConditionDTO drugConditionDTO = new DrugConditionDTO(drugName_first, "", "", "", "", "");
                    RedisUtils.set(conditionDrugName, drugConditionDTO);
                    // 进行聚合
                    JSONObject jsonObject_aa = getJSONObject_aa(drugName_first, "", "", "", "", "", first);
                    jsonArray.add(jsonObject_aa);
                }
            }
        } else {
            if (Objects.isNull(name) || StrUtil.isBlank(name)) {
                return DataResult.error("必须输入 药品名称！！！");
            }
            // 每次都存储最新的用户最后一次所有到的检索次词
            String conditionIdDrugName = Constants.EVIDENCE_ZTE_REPORT_CONDITION_KEY + id + ":" + name;
            DrugConditionDTO drugConditionDTO = new DrugConditionDTO(name, drugName, commodityName, dosage, manufacturer, specification);
            RedisUtils.set(conditionIdDrugName, drugConditionDTO);

            JSONObject jsonObject_aa = getJSONObject_aa(name, drugName, commodityName, specification, dosage, manufacturer, first);
            jsonArray.add(jsonObject_aa);
        }
        return DataResult.data(jsonArray);
    }

    private JSONObject getJSONObject_aa(String name, String drugName, String commodityName, String specification, String dosage, String manufacturer, boolean first) {
        JSONObject result = new JSONObject();

        Set<String> drugNames = new HashSet<>();
        Set<String> commodityNames = new HashSet<>();
        Set<String> specifications = new HashSet<>();
        Set<String> dosages = new HashSet<>();
        Set<String> manufacturers = new HashSet<>();
        DrugAndIndicationIndex drugAndIndicationIndex = new DrugAndIndicationIndex();

        result.put("name", name);
        // 优先在五级中英文 商品名 和 产品名称中精确查询
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        if (StrUtil.isNotBlank(name) && StrUtil.isBlank(drugName)) {
            BoolQueryBuilder drugNameBoolQueryBuilder = new BoolQueryBuilder();
            drugNameBoolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", name));
            drugNameBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugName.keyword", name));
            drugNameBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", name));
            drugNameBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", name));
            boolQueryBuilder.must().add(drugNameBoolQueryBuilder);
        }
        // 产品名称
        if (StrUtil.isNotBlank(drugName)) {
            boolQueryBuilder.must().add(QueryBuilders.termQuery("zhDrugName.keyword", drugName));
        }
        // 商品名称
        if (StrUtil.isNotBlank(commodityName)) {
            BoolQueryBuilder commodityNameNameBoolQueryBuilder = new BoolQueryBuilder();
            commodityNameNameBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", commodityName));
            commodityNameNameBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", commodityName));
            boolQueryBuilder.must().add(commodityNameNameBoolQueryBuilder);
        }
        // 规格
        if (StrUtil.isNotBlank(specification)) {
            boolQueryBuilder.must().add(QueryBuilders.termQuery("specifications.keyword", specification));
        }
        // 剂型
        if (StrUtil.isNotBlank(dosage)) {
            boolQueryBuilder.must().add(QueryBuilders.termQuery("dosageForm.keyword", dosage));
        }
        // 厂家
        if (StrUtil.isNotBlank(manufacturer)) {
            boolQueryBuilder.must().add(QueryBuilders.termQuery("manufacturer.keyword", manufacturer));
        }
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("zhDrugName").field("zhDrugName.keyword").size(1000));
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("commodityNameZh").field("commodityNameZh.keyword").size(1000));
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("commodityNameEn").field("commodityNameEn.keyword").size(1000));
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("specifications").field("specifications.keyword").size(1000));
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("dosageForm").field("dosageForm.keyword").size(1000));
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("manufacturer").field("manufacturer.keyword").size(1000));
        nativeSearchQuery.setTrackScores(true);
        nativeSearchQuery.setTrackTotalHits(true);
        long total = elasticsearchRestTemplate.count(nativeSearchQuery, DrugAndIndicationIndex.class);
        if (total > 0) {
            SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
            drugAndIndicationIndex = search.getSearchHits().get(0).getContent();
            Aggregations aggregations = search.getAggregations();
            if (Objects.nonNull(aggregations)) {
                Aggregation zhDrugName = aggregations.get("zhDrugName");
                List<? extends Terms.Bucket> zhDrugNameBuckets = ((ParsedTerms) zhDrugName).getBuckets();
                for (Terms.Bucket bucket : zhDrugNameBuckets) {
                    if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                        drugNames.add(bucket.getKey().toString());
                    }
                }

                Aggregation commodityNameZh = aggregations.get("commodityNameZh");
                List<? extends Terms.Bucket> commodityNameZhBuckets = ((ParsedTerms) commodityNameZh).getBuckets();
                for (Terms.Bucket bucket : commodityNameZhBuckets) {
                    if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                        commodityNames.add(bucket.getKey().toString());
                    }
                }

                Aggregation commodityNameEn = aggregations.get("commodityNameEn");
                List<? extends Terms.Bucket> commodityNameEnBuckets = ((ParsedTerms) commodityNameEn).getBuckets();
                for (Terms.Bucket bucket : commodityNameEnBuckets) {
                    if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                        commodityNames.add(bucket.getKey().toString());
                    }
                }

                Aggregation specificationsAgg = aggregations.get("specifications");
                List<? extends Terms.Bucket> specificationsBuckets = ((ParsedTerms) specificationsAgg).getBuckets();
                for (Terms.Bucket bucket : specificationsBuckets) {
                    if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                        specifications.add(bucket.getKey().toString());
                    }
                }

                Aggregation dosageFormAgg = aggregations.get("dosageForm");
                List<? extends Terms.Bucket> dosageFormBuckets = ((ParsedTerms) dosageFormAgg).getBuckets();
                for (Terms.Bucket bucket : dosageFormBuckets) {
                    if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                        dosages.add(bucket.getKey().toString());
                    }
                }

                Aggregation manufacturerAgg = aggregations.get("manufacturer");
                List<? extends Terms.Bucket> manufacturerBuckets = ((ParsedTerms) manufacturerAgg).getBuckets();
                for (Terms.Bucket bucket : manufacturerBuckets) {
                    if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                        manufacturers.add(bucket.getKey().toString());
                    }
                }
            }
        } else {
            // 备选只在产品名称中匹配
            BoolQueryBuilder boolQueryBuilder_alt = new BoolQueryBuilder();
            if (StrUtil.isNotBlank(drugName)) {
                boolQueryBuilder_alt.must().add(QueryBuilders.termQuery("zhDrugName.keyword", drugName));
            } else {
                if (StrUtil.isNotBlank(name)) {
                    MatchQueryBuilder zhDrugName = QueryBuilders.matchQuery("zhDrugName", name);
                    zhDrugName.operator(Operator.AND);
                    boolQueryBuilder_alt.must().add(zhDrugName);
                }
            }
            if (StrUtil.isNotBlank(commodityName)) {
                BoolQueryBuilder commodityNameNameBoolQueryBuilder = new BoolQueryBuilder();
                commodityNameNameBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", commodityName));
                commodityNameNameBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", commodityName));
                boolQueryBuilder_alt.must().add(commodityNameNameBoolQueryBuilder);
            }
            if (StrUtil.isNotBlank(specification)) {
                boolQueryBuilder_alt.must().add(QueryBuilders.termQuery("specifications.keyword", specification));
            }
            if (StrUtil.isNotBlank(dosage)) {
                boolQueryBuilder_alt.must().add(QueryBuilders.termQuery("dosageForm.keyword", specification));
            }
            if (StrUtil.isNotBlank(manufacturer)) {
                boolQueryBuilder_alt.must().add(QueryBuilders.termQuery("manufacturer.keyword", manufacturer));
            }
            NativeSearchQuery nativeSearchQuery_alt = new NativeSearchQuery(boolQueryBuilder_alt);
            nativeSearchQuery_alt.addAggregation(AggregationBuilders.terms("zhDrugName").field("zhDrugName.keyword").size(1000));
            nativeSearchQuery_alt.addAggregation(AggregationBuilders.terms("commodityNameZh").field("commodityNameZh.keyword").size(1000));
            nativeSearchQuery_alt.addAggregation(AggregationBuilders.terms("commodityNameEn").field("commodityNameEn.keyword").size(1000));
            nativeSearchQuery_alt.addAggregation(AggregationBuilders.terms("specifications").field("specifications.keyword").size(1000));
            nativeSearchQuery_alt.addAggregation(AggregationBuilders.terms("dosageForm").field("dosageForm.keyword").size(1000));
            nativeSearchQuery_alt.addAggregation(AggregationBuilders.terms("manufacturer").field("manufacturer.keyword").size(1000));
            nativeSearchQuery_alt.setTrackScores(true);
            nativeSearchQuery_alt.setTrackTotalHits(true);
            long total_alt = elasticsearchRestTemplate.count(nativeSearchQuery_alt, DrugAndIndicationIndex.class);
            if (total_alt > 0) {
                SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery_alt, DrugAndIndicationIndex.class);
                drugAndIndicationIndex = search.getSearchHits().get(0).getContent();
                Aggregations aggregations = search.getAggregations();
                if (Objects.nonNull(aggregations)) {
                    Aggregation zhDrugName = aggregations.get("zhDrugName");
                    List<? extends Terms.Bucket> zhDrugNameBuckets = ((ParsedTerms) zhDrugName).getBuckets();
                    for (Terms.Bucket bucket : zhDrugNameBuckets) {
                        if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                            drugNames.add(bucket.getKey().toString());
                        }
                    }

                    Aggregation commodityNameZh = aggregations.get("commodityNameZh");
                    List<? extends Terms.Bucket> commodityNameZhBuckets = ((ParsedTerms) commodityNameZh).getBuckets();
                    for (Terms.Bucket bucket : commodityNameZhBuckets) {
                        if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                            commodityNames.add(bucket.getKey().toString());
                        }
                    }

                    Aggregation commodityNameEn = aggregations.get("commodityNameEn");
                    List<? extends Terms.Bucket> commodityNameEnBuckets = ((ParsedTerms) commodityNameEn).getBuckets();
                    for (Terms.Bucket bucket : commodityNameEnBuckets) {
                        if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                            commodityNames.add(bucket.getKey().toString());
                        }
                    }

                    Aggregation specificationsAgg = aggregations.get("specifications");
                    List<? extends Terms.Bucket> specificationsBuckets = ((ParsedTerms) specificationsAgg).getBuckets();
                    for (Terms.Bucket bucket : specificationsBuckets) {
                        if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                            specifications.add(bucket.getKey().toString());
                        }
                    }

                    Aggregation dosageFormAgg = aggregations.get("dosageForm");
                    List<? extends Terms.Bucket> dosageFormBuckets = ((ParsedTerms) dosageFormAgg).getBuckets();
                    for (Terms.Bucket bucket : dosageFormBuckets) {
                        if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                            dosages.add(bucket.getKey().toString());
                        }
                    }

                    Aggregation manufacturerAgg = aggregations.get("manufacturer");
                    List<? extends Terms.Bucket> manufacturerBuckets = ((ParsedTerms) manufacturerAgg).getBuckets();
                    for (Terms.Bucket bucket : manufacturerBuckets) {
                        if (StrUtil.isNotBlank(bucket.getKey().toString())) {
                            manufacturers.add(bucket.getKey().toString());
                        }
                    }
                }
            }
        }

        List<String> drugNames_list = new ArrayList<>(drugNames);
        List<String> commodityNames_list = new ArrayList<>(commodityNames);
        List<String> dosages_list = new ArrayList<>(dosages);
        List<String> manufacturers_list = new ArrayList<>(manufacturers);
        List<String> specifications_list = new ArrayList<>(specifications);

        if (first) { // 第一次给推荐
            result.put("drugInfo", drugAndIndicationIndex);
        }
        // 产品名称
        if (drugNames_list.contains(drugName)) {
            drugNames_list.remove(drugName);
            drugNames_list.add(0, drugName);
        }
        JSONArray drugNames_Jo = new JSONArray();
        drugNames_Jo.addAll(drugNames_list);
        result.put("drugNames", drugNames_Jo);
        // 商品名称
        if (commodityNames_list.contains(commodityName)) {
            commodityNames_list.remove(commodityName);
            commodityNames_list.add(0, commodityName);
        }
        JSONArray commodityNames_Jo = new JSONArray();
        commodityNames_Jo.addAll(commodityNames_list);
        result.put("commodityNames", commodityNames_Jo);
        // 剂型
        if (dosages_list.contains(dosage)) {
            dosages_list.remove(dosage);
            dosages_list.add(0, dosage);
        }
        JSONArray dosages_Jo = new JSONArray();
        dosages_Jo.addAll(dosages_list);
        result.put("dosages", dosages_Jo);
        // 厂家
        if (manufacturers_list.contains(manufacturer)) {
            manufacturers_list.remove(manufacturer);
            manufacturers_list.add(0, manufacturer);
        }
        JSONArray manufacturers_Jo = new JSONArray();
        manufacturers_Jo.addAll(manufacturers_list);
        result.put("manufacturers", manufacturers_Jo);
        // 规格
        if (specifications_list.contains(specification)) {
            specifications_list.remove(specification);
            specifications_list.add(0, specification);
        }
        JSONArray specifications_Jo = new JSONArray();
        specifications_Jo.addAll(specifications_list);
        result.put("specifications", specifications_Jo);
        return result;
    }


    
    
    
    
    // ################################htaDigest  报告生成   ######################################
    @Override
    public String createToken(String id, long userId, HttpServletRequest request) {
        String token = jwtUtils.createTokenByIdAndUid(id, userId);
        RedisUtils.set(Constants.REPORT_TOKEN + userId + ":" + id, token, 30 * 60, TimeUnit.SECONDS);
        return token;
    }
    
    /**
     * 决策报告的生成
     *
     * @param id          课题id 全局唯一
     * @param update      课题是否进行更新操作 0 否； 1 是 需要判断文献等级是否有提升
     * @param userId      用户id
     * @param verifyToken
     * @return 返回结果封装对象
     */
    @Override
    public DataResult createEvidenceBasedReport(String id, boolean update, Long userId, String type, String source, String verifyToken, HttpServletRequest request) {
        Date startDate = new Date();
        if (StrUtil.isNotBlank(id)) {
            //首页输入查询条件
            Condition condition = mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), Condition.class);
            if (Objects.isNull(condition)) {
                return DataResult.error(401, "没有对应的查询条件可查询！！！");
            }
            JSONObject result = new JSONObject();
            JSONObject data = new JSONObject();
            
            String token = verifyTokenValid(verifyToken);
            //判断是否是默认生成报告
            JSONObject evidenceBasedReport = mongoTemplate.findById(id, JSONObject.class, "evidence_based_report");
            if (evidenceBasedReport == null) {
                questionService.create(id, userId, request);
            } else {
                if (StrUtil.isNotBlank(token)) {
                    //保存课题历史
                    questionService.insertHistory(id);
                } else {
                    return DataResult.data(evidenceBasedReport);
                }
            }

            if ("2".equals(type)) {
                include(id, userId, data);
            }
            long reportBegin = System.currentTimeMillis();
            
            data.put("reportVersion", 1.0);
            RedisUtils.set(Constants.REPORT_VERSION, 1.0);
            
            result.put("id", id);
            data.put("_id", id);
            result.put("userId", userId); // 用户id
            // title
            result.put("title", getInfo(condition) + "循证综合评价报告");
            data.put("title", getInfo(condition) + "循证综合评价报告");
            // 全局参考文献
            JSONObject bibliography = new JSONObject();
            result.put("bibliography", bibliography);
            data.put("bibliography", bibliography);
            result.put("literatureCount", 0);

            // 处理初始数据
            handleInitialData(condition, result);

            // 循证报告正文
            evidenceMain(condition, result, data, userId, evidenceBasedReport);

            // 参考文献
            bibliography(result, data);

            // 参考文献排序
            bibliographySort(data);
            
            // 推荐等级
            //levelJudge(result, update, condition);
            
            // 附录
            //paperEdit(id, result);

            log.info("决策报告课题 id{}, 排除默认纳入报告生成时间{}", id, System.currentTimeMillis() - reportBegin);
            mongoTemplate.remove(new Query(Criteria.where("_id").is(id)), "evidence_based_report");
            mongoTemplate.insert(data, "evidence_based_report");

            tokenInvalid(verifyToken);
            try {
                JSONObject dataJson = new JSONObject();
                dataJson.put("report_id", id);
                dataJson.put("user_id", userId);
                dataJson.put("function", "循证综合评价");
                dataJson.put("module", "药学");
                dataJson.put("report_name", result.getString("title"));
                dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
                manageFeign.addReportInfo(dataJson);
            } catch (Exception e) {
                log.error("循证报告添加机构汇总异常" + e.getCause());
            }

            // app 使用
            //发送kafka生成报告进行微信展示
            log.info("开始发送kafka创建文件--{}", id);
            JSONObject dataJson = new JSONObject();
            dataJson.put("id", id);
            dataJson.put("userId", userId);
            dataJson.put("token", request.getHeader("token"));
            dataJson.put("type", "循证综合评价报告");
            dataJson.put("name", result.getString("title") + ".doc");
            dataJson.put("url", downloadUrl + "?id=" + id + "&source=" + source);
            Date endDate = new Date();
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
            dataJson.put("startTime", format.format(startDate));
            dataJson.put("endTime", format.format(endDate));
            kafkaSender.sendReportInfo(dataJson);
            return DataResult.data(data);
        }
        return DataResult.error();
    }

    private String verifyTokenValid(String verifyToken) {
        Map<String, Claim> claim = jwtUtils.verifyToken(verifyToken);
        if (MapUtil.isNotEmpty(claim)) {
            Long uid = claim.get("uid").asLong();
            String questionId = claim.get("questionId").asString();
            String token = RedisUtils.getStr(Constants.REPORT_TOKEN + uid + ":" + questionId);
            if (StrUtil.isNotBlank(token)) {
                return token;
            }
        }
        return "";
    }

    private void tokenInvalid(String verifyToken) {
        Map<String, Claim> claim = jwtUtils.verifyToken(verifyToken);
        if (MapUtil.isNotEmpty(claim)) {
            Long uid = claim.get("uid").asLong();
            String questionId = claim.get("questionId").asString();
            String token = RedisUtils.getStr(Constants.REPORT_TOKEN + uid + ":" + questionId);
            if (StrUtil.isNotBlank(token)) {
                // 删除 token 使其失效
                RedisUtils.del(Constants.REPORT_TOKEN + uid + ":" + questionId);
            }
        }
    }

    private void bibliographySort(JSONObject data) {

        JSONObject bibliography = data.getJSONObject("bibliography");
        
        List<String> bibliography1 = JSON.parseObject(JSON.toJSONString(bibliography.getJSONArray("bibliographys1")), new TypeReference<List<String>>() {});
        bibliography1.addAll(JSON.parseObject(JSON.toJSONString(bibliography.getJSONArray("bibliographys2")), new TypeReference<List<String>>() {}));
        bibliography1.addAll(JSON.parseObject(JSON.toJSONString(bibliography.getJSONArray("bibliographys3")), new TypeReference<List<String>>() {}));

        bibliography.put("bibliographys1",  bibliography1.stream().sorted(Comparator.comparing((str) -> Integer.parseInt(str.substring(str.indexOf("[") + 1, str.indexOf("]"))))).collect(Collectors.toList()));
        bibliography.put("bibliographys2", Collections.emptyList());
        bibliography.put("bibliographys3", Collections.emptyList());
        data.put("bibliography", bibliography);
    }

    /**
     * 拼接标题
     */
    private String getInfo(Condition condition) {
        StringBuilder info = new StringBuilder();
        List<Drug> drugs = condition.getDrugs();
        if (CollUtil.isNotEmpty(drugs)) {
            for (Drug drug : drugs) {
                Integer status = drug.getStatus();
                if (status == 1) {
                    info.append(drug.getWord());
                } else if (status == 2) {
                    //与
                    info.append("联合");
                } else {
                    //非
                    info.append("排除");
                }
            }
        }
        List<Disease> diseases = condition.getDiseases();
        if (CollUtil.isNotEmpty(diseases)) {
            info.append("用于");
            for (Disease disease : diseases) {
                Integer status = disease.getStatus();
                if (status == 1) {
                    info.append(disease.getWord());
                } else if (status == 2) {
                    //与
                    info.append("合并");
                } else {
                    //非
                    info.append("排除");
                }
            }
        }
        return info.toString();
    }

    private void handleInitialData(Condition condition, JSONObject result) {
        // 处理一下输入的 pico 初始数据
        assembleDrug(condition.getDrugs(), result);
        assembleDisease(condition.getDiseases(), result);
        assembleCompareDrug(condition.getInterventions(), result);
        assembleOutcomes(condition.getOutcomes(), result);
        assembleStudyType(condition.getStudyType(), result);

        // 报告的大标题
        StringBuilder title = new StringBuilder();
        String title_tail = "循证综合评价分析报告";
        List<String> drugAndWord = JSON.parseObject(JSON.toJSONString(result.getJSONArray("drugAndWord")), new TypeReference<List<String>>() {
        });
        if (CollUtil.isNotEmpty(drugAndWord)) {
            String drugUnion = String.join("联合", drugAndWord);
            title.append(drugUnion);
        }

        List<String> diseaseAndWord = JSON.parseObject(JSON.toJSONString(result.getJSONArray("diseaseAndWord")), new TypeReference<List<String>>() {
        });
        if (CollUtil.isNotEmpty(diseaseAndWord)) {
            String diseaseUnion = String.join("合并", diseaseAndWord);
            title.append("用于").append(diseaseUnion);
        }
        title.append(title_tail);
        result.put("title", title.toString());
        log.info("报告标题 {}", title.toString());

        List<Drug> drugs = condition.getDrugs();
        List<Disease> diseases = condition.getDiseases();
        List<String> drugSynonym = new ArrayList<>();
        for (Drug drug : drugs) {
            String word = drug.getWord();
            // 输入词
            drugSynonym.add(word);
            // 翻译词
            String enWord = drug.getEnWord();
            if (StringUtils.isNotBlank(enWord)) {
                drugSynonym.add(enWord);
            }
            // 英文同义词
            List<WordStatus> enSynonym = drug.getEnSynonym();
            if (CollUtil.isNotEmpty(enSynonym)) {
                for (WordStatus wordStatus : enSynonym) {
                    if (wordStatus.getChecked()) {
                        drugSynonym.add(wordStatus.getName());
                    }
                }
            }
            // 中文
            String zhWord = drug.getZhWord();
            if (StringUtils.isNotBlank(zhWord)) {
                drugSynonym.add(zhWord);
            }
            // 中文同义词
            List<WordStatus> zhSynonym = drug.getZhSynonym();
            if (CollUtil.isNotEmpty(zhSynonym)) {
                for (WordStatus wordStatus : zhSynonym) {
                    if (wordStatus.getChecked()) {
                        drugSynonym.add(wordStatus.getName());
                    }
                }
            }

            List<WordStatus> otherSynonym = drug.getOtherSynonym();
            if (CollUtil.isNotEmpty(otherSynonym)){
                for (WordStatus wordStatus : otherSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked) {
                        drugSynonym.add(name);
                    }
                }
            }
            
            // 输入扩展词
            String expandSynonym = drug.getExpandSynonym();
            if (StringUtils.isNotBlank(expandSynonym)) {
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] expandSynonymSplit = expandSynonym.split(";");
                for (String txt : expandSynonymSplit) {
                    if (org.apache.commons.lang.StringUtils.isNotBlank(txt)) {
                        drugSynonym.add(txt.toLowerCase());
                    }
                }
            }
        }
        drugSynonym = drugSynonym.stream().distinct().collect(Collectors.toList());
        result.put("drugSynonym", drugSynonym);

        List<String> diseaseSynonym = new ArrayList<>();
        for (Disease disease : diseases) {
            String word = disease.getWord();
            diseaseSynonym.add(word);
            String enWord = disease.getEnWord();
            if (StringUtils.isNotBlank(enWord)) {
                diseaseSynonym.add(enWord);
            }
            List<WordStatus> enSynonym = disease.getEnSynonym();
            if (CollUtil.isNotEmpty(enSynonym)) {
                for (WordStatus wordStatus : enSynonym) {
                    if (wordStatus.getChecked()) {
                        diseaseSynonym.add(wordStatus.getName());
                    }
                }
            }
            String zhWord = disease.getZhWord();
            if (StringUtils.isNotBlank(zhWord)) {
                diseaseSynonym.add(zhWord);
            }
            List<WordStatus> zhSynonym = disease.getZhSynonym();
            if (CollUtil.isNotEmpty(zhSynonym)) {
                for (WordStatus wordStatus : zhSynonym) {
                    if (wordStatus.getChecked()) {
                        diseaseSynonym.add(wordStatus.getName());
                    }
                }
            }
            
            List<WordStatus> otherSynonym = disease.getOtherSynonym();
            if (CollUtil.isNotEmpty(otherSynonym)){
                for (WordStatus wordStatus : otherSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked) {
                        diseaseSynonym.add(name);
                    }
                }
            }
            String expandSynonym = disease.getExpandSynonym();
            if (StringUtils.isNotBlank(expandSynonym)) {
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] expandSynonymSplit = expandSynonym.split(";");
                for (String txt : expandSynonymSplit) {
                    if (org.apache.commons.lang.StringUtils.isNotBlank(txt)) {
                        diseaseSynonym.add(txt.toLowerCase());
                    }
                }
            }
        }
        diseaseSynonym = diseaseSynonym.stream().distinct().collect(Collectors.toList());
        result.put("diseaseSynonym", diseaseSynonym);

        // 找说明书
        String id = result.getString("id");
        Map<String, String> drug_info_id = new HashMap<>();
        result.put("drug_info_id", drug_info_id);
//        searchFullInstruction(id, drug_info_id);

        searchFullInstructionBak(id, drug_info_id, result);
    }

    private void searchFullInstructionBak(String id, Map<String, String> drug_info_id, JSONObject result) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }

        // 和报告中说明书信息 共用 mongoId
        List<Drug> drugs = condition.getDrugs();
        for (Drug drug : drugs) {
            Integer status = drug.getStatus();
            if (status == 1) {
                Set<String> drugList = new HashSet<>();
                String word = drug.getWord();
                if (StrUtil.isBlank(word)) {
                    continue;
                }
                drugList.add(word);
                String enWord = drug.getEnWord();
                if (StringUtils.isNotBlank(enWord)) {
                    drugList.add(enWord.toLowerCase());
                }
                String zhWord = drug.getZhWord();
                if (StringUtils.isNotBlank(zhWord)) {
                    drugList.add(zhWord.toLowerCase());
                }
                List<WordStatus> enSynonym = drug.getEnSynonym();
                if (CollUtil.isNotEmpty(enSynonym)) {
                    for (WordStatus wordStatus : enSynonym) {
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            drugList.add(wordStatus.getName().toLowerCase());
                        }
                    }
                }
                List<WordStatus> zhSynonym = drug.getZhSynonym();
                if (CollUtil.isNotEmpty(zhSynonym)) {
                    for (WordStatus wordStatus : zhSynonym) {
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            drugList.add(wordStatus.getName().toLowerCase());
                        }
                    }
                }

                List<WordStatus> otherSynonym = drug.getOtherSynonym();
                if (CollUtil.isNotEmpty(otherSynonym)){
                    for (WordStatus wordStatus : otherSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            drugList.add(name);
                        }
                    }
                }

                String xunZhengDrugInfo = "xunzheng:report:" + word;
                JSONObject redisDrugInfoObj = JSON.parseObject(RedisUtils.getStr(xunZhengDrugInfo));
                
                if (Objects.isNull(redisDrugInfoObj)) {
                    JSONObject drugInfoObj = new JSONObject();
                    // 用药助手数据
                    Query query = new Query();
                    query.addCriteria(Criteria.where("drugName").is(word));
                    List<MedicineInfo> medicineInfos = ReleaseMongoUtil.mongo.find(query, MedicineInfo.class);
                    MedicineInfo medicineInfo = null;
                    if (CollUtil.isNotEmpty(medicineInfos)) {
                        medicineInfo = medicineInfos.get(0);
                    }

                    // 用药助手说明书数据
                    Query queryInstruction = new Query();
                    List<Criteria> orCriteriaList = new ArrayList<>();
                    orCriteriaList.add(Criteria.where("innName").regex(word, "i"));
                    orCriteriaList.add(Criteria.where("commonName").regex(word, "i"));
                    queryInstruction.addCriteria(new Criteria().orOperator(orCriteriaList.toArray(new Criteria[0])));
                    List<MedicineInstructionUse> medicineInstructionUses = ReleaseMongoUtil.mongo.find(queryInstruction, MedicineInstructionUse.class);
                    int maxInstructionDataFlag = 0;
                    String instructionUseMongoId = "";
                    if (CollUtil.isNotEmpty(medicineInstructionUses)) {
                        for (MedicineInstructionUse medicineInstructionUse : medicineInstructionUses) {
                            int numData = 0;
                            //禁忌
                            List<DrugFormatDataBo> tabooInd = medicineInstructionUse.getContraindications();
                            if (CollUtil.isNotEmpty(tabooInd)) {
                                numData++;
                            }
                            //妇女
                            List<DrugFormatDataBo> pregnantWomenInd = medicineInstructionUse.getUseInPregLact();
                            if (CollUtil.isNotEmpty(pregnantWomenInd)) {
                                numData++;
                            }
                            //儿童用药
                            List<DrugFormatDataBo> childrenMedicineInd = medicineInstructionUse.getUseInChildren();
                            if (CollUtil.isNotEmpty(childrenMedicineInd)) {
                                numData++;
                            }
                            //老年用药
                            List<DrugFormatDataBo> geriatricMedicineInd = medicineInstructionUse.getUseInElderly();
                            if (CollUtil.isNotEmpty(geriatricMedicineInd)) {
                                numData++;
                            }
                            //用法用量
                            List<DrugFormatDataBo> usageAndDosageInd = medicineInstructionUse.getDosage();
                            if (CollUtil.isNotEmpty(usageAndDosageInd)) {
                                numData++;
                            }
                            //不良反应
                            List<DrugFormatDataBo> adverseReactionInd = medicineInstructionUse.getAdverseReactions();
                            if (CollUtil.isNotEmpty(adverseReactionInd)) {
                                numData++;
                            }
                            //适应症
                            List<DrugFormatDataBo> indicationsInd = medicineInstructionUse.getIndication();
                            if (CollUtil.isNotEmpty(indicationsInd)) {
                                numData++;
                            }
                            //注意事项 notes
                            List<DrugFormatDataBo> notes = medicineInstructionUse.getPrecautions();
                            if (CollUtil.isNotEmpty(notes)) {
                                numData++;
                            }
                            //相互作用
                            List<DrugFormatDataBo> interaction = medicineInstructionUse.getDrugInteractions();
                            if (CollUtil.isNotEmpty(interaction)) {
                                numData++;
                            }
                            // 药理作用
                            List<DrugFormatDataBo> pharmacology = medicineInstructionUse.getMechanismAction();
                            if (CollUtil.isNotEmpty(pharmacology)) {
                                numData++;
                            }
                            // 药代动力学
                            List<DrugFormatDataBo> pharmacokinetics = medicineInstructionUse.getPharmacokinetics();
                            if (CollUtil.isNotEmpty(pharmacokinetics)) {
                                numData++;
                            }
                            //黑框警告
                            List<DrugFormatDataBo> warning = medicineInstructionUse.getDrugWarning();
                            if (CollUtil.isNotEmpty(warning)) {
                                numData++;
                            }
                            //贮藏
                            List<DrugFormatDataBo> storage = medicineInstructionUse.getStorage();
                            if (CollUtil.isNotEmpty(storage)) {
                                numData++;
                            }
                            if (maxInstructionDataFlag < numData) {
                                maxInstructionDataFlag = numData;
                                instructionUseMongoId = medicineInstructionUse.getId();
                            }
                        }
                    }
                    MedicineInstructionUse medicineInstructionUse = ReleaseMongoUtil.mongo.findById(instructionUseMongoId, MedicineInstructionUse.class);
                    
                    drugInfoObj.put("name", word);
                    if (Objects.nonNull(medicineInstructionUse)) {
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getIndication())) {
                            drugInfoObj.put("indications", medicineInstructionUse.getIndication());
                        } else {
                            if (CollUtil.isNotEmpty(medicineInstructionUse.getEffectsAndIndications())) {
                                drugInfoObj.put("indications", medicineInstructionUse.getEffectsAndIndications());
                            }
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getDosage())) {
                            drugInfoObj.put("usageAndDosage", medicineInstructionUse.getDosage());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getMechanismAction())) {
                            drugInfoObj.put("pharmacology", medicineInstructionUse.getMechanismAction());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getPharmacokinetics())) {
                            drugInfoObj.put("pharmacokinetics", medicineInstructionUse.getPharmacokinetics());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getUseInChildren())) {
                            drugInfoObj.put("children", medicineInstructionUse.getUseInChildren());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getUseInElderly())) {
                            drugInfoObj.put("geriatric", medicineInstructionUse.getUseInElderly());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getUseInPregLact())) {
                            drugInfoObj.put("pregnantWomen", medicineInstructionUse.getUseInPregLact());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getAdverseReactions())) {
                            drugInfoObj.put("adverse", medicineInstructionUse.getAdverseReactions());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getDrugWarning())) {
                            drugInfoObj.put("warning", medicineInstructionUse.getDrugWarning());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getPrecautions())) {
                            drugInfoObj.put("notes", medicineInstructionUse.getPrecautions());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getContraindications())) {
                            drugInfoObj.put("taboo", medicineInstructionUse.getContraindications());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getStorage())) {
                            drugInfoObj.put("storage", medicineInstructionUse.getStorage());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getDrugInteractions())) {
                            drugInfoObj.put("adverseReaction", medicineInstructionUse.getDrugInteractions());
                        }
                    }

                    if (Objects.nonNull(medicineInfo)) {
                        if (CollUtil.isNotEmpty(medicineInfo.getNotes())) {
                            drugInfoObj.put("notes", medicineInfo.getNotes());
                        }

                        if (CollUtil.isNotEmpty(medicineInfo.getIndicationsDosage())) {
                            drugInfoObj.put("type", 1);
                            drugInfoObj.put("indicationsDosage", medicineInfo.getIndicationsDosage());
                        }

                        if (CollUtil.isNotEmpty(medicineInfo.getPharmacology())) {
                            drugInfoObj.put("pharmacology", medicineInfo.getPharmacology());
                        }

                        if (CollUtil.isNotEmpty(medicineInfo.getPharmacokinetics())) {
                            drugInfoObj.put("pharmacokinetics", medicineInfo.getPharmacokinetics());
                        }

                        if (CollUtil.isNotEmpty(medicineInfo.getWarning())) {
                            drugInfoObj.put("warning", medicineInfo.getWarning());
                        }

                        if (CollUtil.isNotEmpty(medicineInfo.getChildren())) {
                            drugInfoObj.put("children", medicineInfo.getChildren());
                        }

                        if (CollUtil.isNotEmpty(medicineInfo.getTaboo())) {
                            drugInfoObj.put("taboo", medicineInfo.getTaboo());
                        }

                        if (CollUtil.isNotEmpty(medicineInfo.getStorage())) {
                            drugInfoObj.put("storage", medicineInfo.getStorage());
                        }

                        if (CollUtil.isNotEmpty(medicineInfo.getAdverseReaction())) {
                            drugInfoObj.put("adverse", medicineInfo.getAdverseReaction());
                        }

                        // 妊娠期&哺乳期
                        List<DrugFormatDataBo> medication = new ArrayList<>();
                        List<DrugFormatDataBo> medicationDuringLactation = medicineInfo.getMedicationDuringLactation();
                        List<DrugFormatDataBo> medicationDuringPregnancy = medicineInfo.getMedicationDuringPregnancy();
                        if (CollUtil.isNotEmpty(medicationDuringLactation)) {
                            medication.addAll(medicationDuringLactation);
                        }
                        if (CollUtil.isNotEmpty(medicationDuringPregnancy)) {
                            medication.addAll(medicationDuringPregnancy);
                        }
                        drugInfoObj.put("pregnantWomen", medication);
                    }
                    // 说明书信息补全
                    instructionInfoComplemented(drugInfoObj);
                    RedisUtils.set(xunZhengDrugInfo, JSON.toJSONString(drugInfoObj), 60 * 60 * 6, TimeUnit.SECONDS);
                }
                
                redisDrugInfoObj = JSON.parseObject(RedisUtils.getStr(xunZhengDrugInfo));
                if (Objects.nonNull(redisDrugInfoObj)) {
                    drug_info_id.put(word, xunZhengDrugInfo);
                }
            }
        }
    }

    private void instructionInfoComplemented(JSONObject drugInfoObj) {
        // 药理作用
        JSONArray pharmacology = drugInfoObj.getJSONArray("pharmacology");
        // 药代动力学
        JSONArray pharmacokinetics = drugInfoObj.getJSONArray("pharmacokinetics");
        // 适应证
        JSONArray indications = drugInfoObj.getJSONArray("indications");
        // 用法用量
        JSONArray usageAndDosage = drugInfoObj.getJSONArray("usageAndDosage");
        // 禁忌
        JSONArray taboo = drugInfoObj.getJSONArray("taboo");
        // 注意事项
        JSONArray notes = drugInfoObj.getJSONArray("notes");
        // 不良反应
        JSONArray adverse = drugInfoObj.getJSONArray("adverse");
        // 贮藏
        JSONArray storage = drugInfoObj.getJSONArray("storage");
        // 相互作用
        JSONArray adverseReaction = drugInfoObj.getJSONArray("adverseReaction");

        String drugName = drugInfoObj.getString("name");
        if (CollUtil.isEmpty(pharmacology) ||
                CollUtil.isEmpty(pharmacokinetics) ||
                CollUtil.isEmpty(indications) ||
                CollUtil.isEmpty(usageAndDosage) ||
                CollUtil.isEmpty(taboo) ||
                CollUtil.isEmpty(notes) ||
                CollUtil.isEmpty(adverse) ||
                CollUtil.isEmpty(storage) ||
                CollUtil.isEmpty(adverseReaction)) {
            JSONObject result = new JSONObject();

            String question_1 = "  请你作为一名专业的临床药理学专家，非常善于查找药品的各方面信息。这对你来说是一个非常简单的任务。" +
                    "  请你根据提供的药品，进行深度搜索、挖掘。找到该药品的药理作用（包括作用机制、药效学等方面）、药代动力学、适应证、用法用量、禁忌、注意事项、不良反应、贮藏、相互作用这些方面的相关信息，并对这些信息内容进行总结。" +
                    "\n" +
                    "\n" +
                    "  提供几个检索思路、路径以及内容优先选取顺序（但不限于只使用以下几种查找方式，请进行深度搜索）如下，：" +
                    "   1、请优先使用药品说明书中的‘药理作用’部分。" +
                    "   2、其次参考学术期刊和医学网站中的相关文章或是研究。" +
                    "   3、最后可以在专业的医疗网站，比如 WebMD、MedlinePlus等，去查找补充信息”。" +
                    "\n" +
                    "\n" +
                    "   `注意` 总结的内容请使用中文进行回答。\n" +
                    "   `注意` 返回的格式请严格按照如下返回：\n" +
                    "   1、结果严格按照JSON格式返回。\n" +
//                    "   2、返回的结果中只有一个属性result。`result用来接收总结的药品的药理作用内容`。\n" +
                    "   2、返回的结果中请使用result来接收所有字段内容。" +
                    "       `pharmacology`接收药理作用总结内容。" +
                    "       `pharmacokinetics`接收药代动力学总结内容。" +
                    "       `indications`接收适应证总结内容。" +
                    "       `usageAndDosage`接收用法用量总结内容。" +
                    "       `taboo`接收禁忌总结内容。" +
                    "       `notes`接收注意事项总结内容。" +
                    "       `adverse`接收不良反应总结内容。" +
                    "       `storage`接收贮藏总结内容。" +
                    "       `adverseReaction`接收相互作作用总结内容。\n" +
//                    "   3、返回的结果请用一段字符串数据来描述。返回内容使用result来接收，不要再在result中加入其它属性字段。" +
                    "   3、返回的结果请用一段字符串数据来描述，如果返回的内容有段落感，可以使用 `\n` 修饰符来增加修饰（但不要破坏内容的JSON格式）。返回内容使用result来接收，不要再在result中加入其它属性字段。" +
                    "\n" +
                    "\n" +
                    "   药品如下：{"+ drugName + "}";
            try {
                JSONObject jsonObject2 = new JSONObject();
                jsonObject2.put("prompt", question_1);
                String resultAs = medicineFeign.gpt4oMini(jsonObject2);
                if (StrUtil.isNotBlank(resultAs)) {
                    int start = resultAs.indexOf('{');
                    int end = resultAs.lastIndexOf('}');
                    String subResult = resultAs.substring(start, end + 1);
                    JSONObject obj = JSON.parseObject(subResult);
                    result = obj.getJSONObject("result");

                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }

            if (CollUtil.isEmpty(pharmacology)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(result.getString("pharmacology"));
                drugInfoObj.put("pharmacology", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(pharmacokinetics)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(result.getString("pharmacokinetics"));
                drugInfoObj.put("pharmacokinetics", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(indications)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(result.getString("indications"));
                drugInfoObj.put("indications", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(usageAndDosage)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(result.getString("usageAndDosage"));
                drugInfoObj.put("usageAndDosage", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(taboo)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(result.getString("taboo"));
                drugInfoObj.put("taboo", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(notes)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(result.getString("notes"));
                drugInfoObj.put("notes", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(adverse)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(result.getString("adverse"));
                drugInfoObj.put("adverse", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(storage)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(result.getString("storage"));
                drugInfoObj.put("storage", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(adverseReaction)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(result.getString("adverseReaction"));
                drugInfoObj.put("adverseReaction", Collections.singletonList(drugFormatDataBo));
            }
        }

        
        // 儿童用药
        JSONArray children = drugInfoObj.getJSONArray("children");
        // 老人用药
        JSONArray geriatric = drugInfoObj.getJSONArray("geriatric");
        // 妇女用药
        JSONArray pregnantWomen = drugInfoObj.getJSONArray("pregnantWomen");
        
        if (CollUtil.isNotEmpty(children) ||
                CollUtil.isNotEmpty(geriatric) ||
                CollUtil.isNotEmpty(pregnantWomen)) {
            JSONObject specialResult = new JSONObject();
            String question_2 = "  请你作为一名专业的临床药理学专家，非常善于查找药品的各方面信息。这对你来说是一个非常简单的任务。" +
                    "  请你根据提供的药品，进行深度搜索、挖掘。找到该药品对于特殊人群（儿童、老人、孕妇及哺乳期妇女）的用药方面有什么特殊的要求嘛，并对这些信息内容进行总结。" +
                    "\n" +
                    "\n" +
                    "  提供几个检索思路、路径以及内容优先选取顺序（但不限于只使用以下几种查找方式，请进行深度搜索）如下，：" +
                    "   1、请优先使用药品说明书中的‘药理作用’部分。" +
                    "   2、其次参考学术期刊和医学网站中的相关文章或是研究。" +
                    "   3、最后可以在专业的医疗网站，比如 WebMD、MedlinePlus等，去查找补充信息”。" +
                    "\n" +
                    "\n" +
                    "   `注意` 总结的内容请使用中文进行回答。\n" +
                    "   `注意` 返回的格式请严格按照如下返回：\n" +
                    "   1、结果严格按照JSON格式返回。\n" +
//                    "   2、返回的结果中只有一个属性result。`result用来接收总结的药品的药理作用内容`。\n" +
                    "   2、返回的结果中请使用result来接收所有字段内容。" +
                    "       `children`接收儿童用药方面总结内容。" +
                    "       `geriatric`接收老人用药方面总结内容。" +
                    "       `pregnantWomen`接收孕妇及哺乳期妇女用药方面总结内容。\n" +
//                    "   3、返回的结果请用一段字符串数据来描述。返回内容使用result来接收，不要再在result中加入其它属性字段。" +
                    "   3、返回的结果请用一段字符串数据来描述，如果返回的内容有段落感，可以使用 `\n` 修饰符来增加修饰（但不要破坏内容的JSON格式）。返回内容使用result来接收，不要再在result中加入其它属性字段。" +
                    "\n" +
                    "\n" +
                    "   药品如下：{"+ drugName + "}";
            try {
                JSONObject jsonObject2 = new JSONObject();
                jsonObject2.put("prompt", question_2);
                String resultAs = medicineFeign.gpt4oMini(jsonObject2);
                if (StrUtil.isNotBlank(resultAs)) {
                    int start = resultAs.indexOf('{');
                    int end = resultAs.lastIndexOf('}');
                    String subResult = resultAs.substring(start, end + 1);
                    JSONObject obj = JSON.parseObject(subResult);
                    specialResult = obj.getJSONObject("result");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }

            if (CollUtil.isEmpty(children)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(specialResult.getString("children"));
                drugInfoObj.put("children", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(geriatric)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(specialResult.getString("geriatric"));
                drugInfoObj.put("geriatric", Collections.singletonList(drugFormatDataBo));
            }

            if (CollUtil.isEmpty(pregnantWomen)) {
                DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                drugFormatDataBo.setTag("text");
                drugFormatDataBo.setContent(specialResult.getString("pregnantWomen"));
                drugInfoObj.put("pregnantWomen", Collections.singletonList(drugFormatDataBo));
            }
        }
    }

    /**
     * 拼接疾病 如 糖尿病合并肥胖性糖尿病
     */
    private void assembleDisease(List<Disease> diseases, JSONObject result) {
        result.put("diseaseAndNotStr", "---");

        if (CollUtil.isEmpty(diseases)) {
            return;
        }

        boolean isRejected = false;
        List<Disease> diseaseAnd = new ArrayList<>();
        List<String> diseaseAndWord = new ArrayList<>();
        StringBuilder diseaseAndNotStr = new StringBuilder();

        for (Disease disease : diseases) {
            if (disease.getStatus() == 1) {
                if (!isRejected) {
                    diseaseAnd.add(disease);
                    diseaseAndWord.add(disease.getWord());
                    diseaseAndNotStr.append(disease.getWord());
                } else {
                    isRejected = false;
                    diseaseAndNotStr.append(disease.getWord());
                }
            }
            if (disease.getStatus() == 2) {
                diseaseAndNotStr.append("&");
            }
            if (disease.getStatus() == 3) {
                isRejected = true;
                diseaseAndNotStr.append("!");
            }
        }
        result.put("diseaseAnd", diseaseAnd);
        result.put("diseaseAndWord", diseaseAndWord);
        result.put("diseaseAndNotStr", diseaseAndNotStr.toString());
    }

    /**
     * 拼接药品 如 二甲双胍联合二甲苯
     */
    private void assembleDrug(List<Drug> drugs, JSONObject result) {
        result.put("drugAndNotStr", "---");

        if (CollUtil.isEmpty(drugs)) {
            return;
        }

        boolean isRejected = false;
        List<Drug> drugAnd = new ArrayList<>(); // and  进行连接的Drug对象集合
        List<String> drugAndWord = new ArrayList<>(); // and 进行连接的drug.word集合
        List<Drug> drugNot = new ArrayList<>(); // not 之后的Drug对象集合
        StringBuilder drugAndNotStr = new StringBuilder();
        List<String> drugAndWordEn = new ArrayList<>(); // and 进行连接的drug.word集合

        for (Drug drug : drugs) {
            if (drug.getStatus() == 1) {
                if (!isRejected) {
                    drugAnd.add(drug);
                    drugAndWord.add(drug.getWord());
                    drugAndWordEn.add(drug.getEnWord());
                    drugAndNotStr.append(drug.getWord());
                } else {
                    drugNot.add(drug);
                    drugAndNotStr.append(drug.getWord());
                    isRejected = false;
                }
            }
            if (drug.getStatus() == 2) {
                drugAndNotStr.append("&");
            }
            if (drug.getStatus() == 3) {
                isRejected = true;
                drugAndNotStr.append("!");
            }
        }
        result.put("drugAnd", drugAnd);
        result.put("drugAndWord", drugAndWord);
        result.put("drugAndWordEn", drugAndWordEn);
        result.put("drugNot", drugNot);
        result.put("drugAndNotStr", drugAndNotStr.toString());
    }

    /**
     * 拼接对照药品 如 二甲双胍联合二甲苯
     */
    private void assembleCompareDrug(List<InterventionAndOutcome> compareDrugs, JSONObject result) {
        result.put("compareDrugAndNotStr", "---");

        if (CollUtil.isEmpty(compareDrugs)) {
            return;
        }

        boolean isRejected = false;
        List<InterventionAndOutcome> compareDrugAnd = new ArrayList<>();
        List<String> compareDrugAndWord = new ArrayList<>();
        List<InterventionAndOutcome> compareDrugNot = new ArrayList<>();
        StringBuilder compareDrugAndNotStr = new StringBuilder();

        for (InterventionAndOutcome compareDrug : compareDrugs) {
            if (compareDrug.getStatus() == 1) {
                if (!isRejected) {
                    compareDrugAndNotStr.append(compareDrug.getWord());
                    compareDrugAnd.add(compareDrug);
                    compareDrugAndWord.add(compareDrug.getWord());
                } else {
                    compareDrugNot.add(compareDrug);
                    compareDrugAndNotStr.append(compareDrug.getWord());
                    isRejected = false;
                }
            }
            if (compareDrug.getStatus() == 2) {
                compareDrugAndNotStr.append("&");
            }
            if (compareDrug.getStatus() == 3) {
                isRejected = true;
                compareDrugAndNotStr.append("!");
            }
        }
        result.put("compareDrugAnd", compareDrugAnd);
        result.put("compareDrugAndWord", compareDrugAndWord);
        result.put("compareDrugNot", compareDrugNot);
        result.put("compareDrugAndNotStr", compareDrugAndNotStr.toString());
    }

    /**
     * 拼接对照药品 如 二甲双胍联合二甲苯
     */
    private void assembleOutcomes(List<InterventionAndOutcome> compareDrugs, JSONObject result) {
        result.put("outcomeAndNotStr", "---");

        if (CollUtil.isEmpty(compareDrugs)) {
            return;
        }

        boolean isRejected = false;
        StringBuilder outcomeAndNotStr = new StringBuilder();

        for (InterventionAndOutcome compareDrug : compareDrugs) {
            if (compareDrug.getStatus() == 1) {
                outcomeAndNotStr.append(compareDrug.getWord());
                if (isRejected) {
                    isRejected = false;
                }
            }
            if (compareDrug.getStatus() == 2) {
                outcomeAndNotStr.append("&");
            }
            if (compareDrug.getStatus() == 3) {
                isRejected = true;
                outcomeAndNotStr.append("!");
            }
        }
        result.put("outcomeAndNotStr", outcomeAndNotStr.toString());
    }

    /**
     * 拼接研究类型 如 二甲双胍联合二甲苯
     */
    private void assembleStudyType(List<Integer> studyType, JSONObject result) {
        result.put("studyTypeStr", "---");

        if (CollUtil.isEmpty(studyType)) {
            return;
        }

        StringBuilder studyTypeStr = new StringBuilder();
        for (Integer type : studyType) {
            switch (type) {
                case 0:
                    studyTypeStr.append("系统综述/Meta分析、");
                    continue;
                case 1:
                    studyTypeStr.append("传统综述、");
                    continue;
                case 2:
                    studyTypeStr.append("随机对照试验、");
                    continue;
                case 3:
                    studyTypeStr.append("队列研究、");
                    continue;
                case 4:
                    studyTypeStr.append("病例对照研究、");
                    continue;
                case 5:
                    studyTypeStr.append("横断面研究、");
                    continue;
                case 6:
                    studyTypeStr.append("病例系列、");
                    continue;
                case 7:
                    studyTypeStr.append("病例报告、");
                    continue;
                case 8:
                    studyTypeStr.append("专家意见和评价、");
                    continue;
                case 9:
                    studyTypeStr.append("动物实验、");
                    continue;
                case 10:
                    studyTypeStr.append("体外实验、");
                    continue;
                case 11:
                    studyTypeStr.append("指南/共识、");
                    continue;
                case 13:
                    studyTypeStr.append("其他、");
                    continue;
                case 14:
                    studyTypeStr.append("临床试验、");
                    continue;
                default:
                    break;
            }
        }

        String substring = studyTypeStr.toString();
        if (StrUtil.isNotBlank(studyTypeStr)) {
            substring = studyTypeStr.substring(0, studyTypeStr.length() - 1);
        }
        result.put("studyTypeStr", substring);
    }

    // ################################htaMain  正文部分   ######################################

    /**
     * 卫生技术评估（HTA）报告正文
     */
    private void evidenceMain(Condition condition, JSONObject result, JSONObject data, Long userId, JSONObject evidenceBasedReport) {
        ExecutorService executorService = Executors.newFixedThreadPool(9);
        executorService.execute(() -> {
            // 背景
            background(result, data);
            log.info("背景模块完成！！！");

            //  国内外指南/共识
            guide(result, data, evidenceBasedReport, condition, userId);
            log.info("指南完成");

            //  文献
            literatureResult(condition, result, data, evidenceBasedReport);
            log.info("文献完成");
        });

        executorService.execute(() -> {
            // 带评价药品基本信息
            instructionInfos(result, data);
            log.info("待评价药品基本信息模块完成");
        });

        executorService.execute(() -> {
            // 带评价药品国外说明书基本信息 
            instructionsOtherInfo(result, data);
            log.info("待评价药品国外说明书基本信息模块完成");
        });

        executorService.execute(() -> {
            // 参比药品
            JSONArray drugAndWord = result.getJSONArray("drugAndWord");
            JSONArray diseaseAndWord = result.getJSONArray("diseaseAndWord");
            if (CollUtil.isNotEmpty(drugAndWord)) {
                List<String> drugs = drugAndWord.stream().map(Object::toString).collect(Collectors.toList());
                List<String> diseases = diseaseAndWord.stream().map(Object::toString).collect(Collectors.toList());
//                try {
//                    List<JSONObject> searchCB = aiSearchLGService.searchCB(drugs, diseases);
//                    filterCB(searchCB);
//                    data.put("cb", searchCB);
//                } catch (Exception e) {
//                    data.put("cb", new ArrayList<>());
//                }
                log.info("获取参比药品模块完成");
            }
            
        });

        executorService.execute(() -> {
            // 其他国家或地区 HTA 组织评估情况
            htaReportByOtherVarious(result, condition, userId);
            JSONObject hta = new JSONObject();
            hta.put("effectiveness", filterHtaCon(result, "effectiveness", "有效性"));
            hta.put("security", filterHtaCon(result, "security", "安全性"));
            hta.put("economicViability", filterHtaCon(result, "economicViability", "经济性"));
            data.put("hta", hta);
            log.info("其他国家或地区 HTA 组织评估情况模块完成");
        });

        executorService.execute(() -> {
            // 真实世界数据登记
            showDBAnalysis(result, data);
            log.info("真实世界数据登记完成");
        });

        executorService.execute(() -> {
            // 药物警戒快讯
            showPolicyAnalysis(result, data);
            log.info("药物警戒快讯完成");
        });

        executorService.execute(() -> {
            // CDE评审报告情况
            reviewReport(result, data);
            log.info("CDE评审报告完成");
        });

        executorService.execute(() -> {
            // 7、 其他属性
            // 药品在国家医保目录、国家基本药物目录（2018年版）中收录情况、国家集采药品目录、贮藏条件
            drugCondition(result, data);
            log.info("其他属性模块完成");
        });

        // 8、 总结
        summarizeBrief(result, data);
        log.info("总结模块完成");

        executorService.shutdown();
        try {
            // 等待所有任务完成，直到超时或者所有任务执行完毕
            // 参数是等待的时间，在这里设为0表示无限等待
            boolean terminated = executorService.awaitTermination(Long.MAX_VALUE, TimeUnit.MILLISECONDS);
            if (terminated) {
                log.info("htaMain所有模块完成，线程池关闭。");
            } else {
                log.info("htaMain模块等待超时，但线程池可能仍有任务在执行。");
            }
        } catch (InterruptedException e) {
            // 处理中断异常
            log.info("等待过程中被中断。");
            Thread.currentThread().interrupt(); 
        }
    }

    private void filterCB(List<JSONObject> cbDrugInfo) {
        if (CollUtil.isNotEmpty(cbDrugInfo)) {
            for (JSONObject jo : cbDrugInfo) {
                JSONArray table = jo.getJSONArray("table");
                JSONArray resultTable = new JSONArray();
                if (CollUtil.isNotEmpty(table)) {
                    for (Object o : table) {
                        int count = 0;
                        JSONObject info = JSON.parseObject(JSON.toJSONString(o));
                        if (StrUtil.isBlank(info.getString("special")) || "-".equals(info.getString("special"))) {
                            count ++;
                        }
                        if (StrUtil.isBlank(info.getString("innovation")) || "-".equals(info.getString("innovation"))) {
                            count ++;
                        }
                        if (StrUtil.isBlank(info.getString("effective")) || "-".equals(info.getString("effective"))) {
                            count ++;
                        }
                        if (StrUtil.isBlank(info.getString("indications")) || "-".equals(info.getString("indications"))) {
                            count ++;
                        }
                        if (StrUtil.isBlank(info.getString("safety")) || "-".equals(info.getString("safety"))) {
                            count ++;
                        }
                        if (StrUtil.isBlank(info.getString("pattern")) || "-".equals(info.getString("pattern"))) {
                            count ++;
                        }
                        if (StrUtil.isBlank(info.getString("mechanics")) || "-".equals(info.getString("mechanics"))) {
                            count ++;
                        }
                        if (StrUtil.isBlank(info.getString("time")) || "-".equals(info.getString("time"))) {
                            count ++;
                        }
                        if (StrUtil.isBlank(info.getString("name")) || "-".equals(info.getString("name"))) {
                            count ++;
                        }
                        if (count < 8) {
                            resultTable.add(o);
                        }
                    }
                    jo.put("table", resultTable);
                }
            }
        }
        
        
    }

    /**
     * 要点总结--背景
     */
    private void background(JSONObject result, JSONObject data) {
        JSONObject bibliography = result.getJSONObject("bibliography");
        int literatureCount = result.getInteger("literatureCount");
        ;
        // 背景问题
        String drugAndNotStr = result.getString("drugAndNotStr").replaceAll("&", "合并");
        String diseaseAndNotStr = result.getString("diseaseAndNotStr").replaceAll("&", "联合");
        String queryFirst = "请你作为一位卫生技术评估专家，分段落分别简述一下" + drugAndNotStr + "的药理作用；"
                + diseaseAndNotStr + "的定义、临床特点；"
                + drugAndNotStr + "治疗" + diseaseAndNotStr + "的相关研究进展。";

        String queryTwo = "请你作为一位卫生技术评估专家，分段落分别简述一下" + drugAndNotStr + "的药理作用；"
                + diseaseAndNotStr + "的定义、临床特点；"
                + drugAndNotStr + "治疗" + diseaseAndNotStr + "的相关研究进展。" +
                "要求在给出的结果内容中的每句后用方括号加数字表示标识其参考的是给定的知识库数据对应的数据序号，如[1]，" +
                "特别注意：在回答最后不要列出参考文献内容和不要列出所有参考文献序号。给定的知识库数据为：";

        JSONArray bibliographys1 = new JSONArray();
        bibliography.put("bibliographys1", bibliographys1);

        String answer = "";
        if (StrUtil.isNotBlank(queryFirst)) {
            try {
                JSONArray literatureList = new JSONArray();
                answer = aboutLiteratureNumber(result, literatureList, queryFirst, queryTwo, true, 2014, 2024, 20);
                answer = wiffOfContent(answer, "\\*", "");
                answer = wiffOfContent(answer, "#", "");
                answer = wiffout(literatureCount, answer, literatureList, bibliographys1, result);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
        data.put("background", answer);
    }

    private String aboutLiteratureNumber(JSONObject result, JSONArray literatureList, String queryFirst, String queryTwo, boolean languageFlag, int startYear, int endYear, int pageSize) {
        String answer = "";
        // 文献结果
        List<Map<String, String>> evidence = medicineFeign.evidence(queryFirst, languageFlag, startYear, endYear, pageSize);
        String prompt = formatList(evidence, null, null, literatureList);
        // 问题
        String question = queryTwo + prompt;
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("prompt", question);
        jsonObject.put("model", "gpt-4o-2024-11-20");
        answer = medicineFeign.gpt4oMini(jsonObject);
        return answer;
    }

    public String formatList(List<Map<String, String>> evidence, Map<String, Map<String, String>> allKnowledge, Map<Integer, String> knowledgeIds, JSONArray literatureList) {
        List<String> list = new ArrayList<>();
        for (int i = 0; i < evidence.size(); i++) {
            Map<String, String> map = evidence.get(i);
            String question = map.get("question");
            String answer = map.get("answer");
            String id = map.get("id");
            if (allKnowledge != null) {
                allKnowledge.put(id, map);
            }
            if (knowledgeIds != null) {
                knowledgeIds.put(i + 1, id);
            }
            list.add("[" + (i + 1) + "] " + question + "\n" + answer);

            JSONObject literature = new JSONObject();
            literature.put("id", id);
            literature.put("title", map.get("title"));
            MongoLiterature mongoLiterature = fineScreenFeign.paper(id);
//            MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findById(id, MongoLiterature.class, "mongo_literature_" + Math.abs(id.hashCode()) % 10);
            literature.put("literature", mongoLiterature);
            literatureList.add(literature);
        }
        return String.join("\n-----\n", list);
    }


    private String wiffout(int literatureCount, String answer, JSONArray literatureList, JSONArray bibliographys, JSONObject result) {
        Map<String, JSONObject> literatureMap = new HashMap<>();
        List<String> paperIds = new ArrayList<>();
        for (Object o : literatureList) {
            JSONObject jsonObject = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
            paperIds.add(jsonObject.getString("id"));
            literatureMap.put(jsonObject.getString("id"), jsonObject.getJSONObject("literature"));
        }
        Map<Integer, Boolean> map = new HashMap<>();
        int haveNumber = signNumber(answer, paperIds, map, literatureMap);
        literatureCount += haveNumber;
        int endLiteratureCount = literatureCount;

        for (int i = paperIds.size(); i > 0; ) {
            String paperId = paperIds.get(i - 1);
            if (paperId.contains("-")) {
                answer = answer.replace("[" + (i) + "]", "");
                i--;
            } else {
                // 已经排除是资讯 此处就表示查询不到 paper 请有序号的置为""
                if (!map.get(i)) {
                    answer = answer.replace("[" + (i) + "]", "");
                    i--;
                    continue;
                }
                // 查询 paper 文献
                try {
                    JSONObject jsonObject = literatureMap.get(paperId);
                    MongoLiterature mongoLiterature = fineScreenFeign.paper(jsonObject.getString("id"));
//                    MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findById(jsonObject.getString("id"), MongoLiterature.class, "mongo_literature_" + Math.abs(jsonObject.getString("id").hashCode()) % 10);
                    if (Objects.nonNull(mongoLiterature)) {
                        if (Objects.nonNull(mongoLiterature.getAuthor()) && CollUtil.isNotEmpty(mongoLiterature.getAuthor())) {
                            mongoLiterature.setAuthor(mongoLiterature.getAuthor());
                        } else {
                            mongoLiterature.setAuthor(Collections.emptyList());
                        }
                    } else {
                        mongoLiterature = new MongoLiterature();
                        String author = jsonObject.getString("author");
                        if (StrUtil.isNotBlank(author)) {
                            mongoLiterature.setAuthor(Arrays.asList(author.split(",")));
                        } else {
                            mongoLiterature.setAuthor(Collections.emptyList());
                        }
                        mongoLiterature.setTitle(jsonObject.getString("title"));
                        mongoLiterature.setJournal(jsonObject.getString("journal"));
                        mongoLiterature.setYear(jsonObject.getString("year"));
                    }
                    refrenceBuilder(mongoLiterature, bibliographys, "[" + literatureCount + "]");
                    answer = answer.replace("[" + (i) + "]", "【" + literatureCount + "】");
                    literatureCount--;
                    i--;
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            }
        }
        Collections.reverse(bibliographys);
        // 分析完文献需要 在将 literatureCOunt 设置文目前文献数量
        result.put("literatureCount", endLiteratureCount);
        answer = answer.replaceAll("【", "<sup>[");
        answer = answer.replaceAll("】", "]</sup>");
        return answer;
    }

    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) {
            return "";
        }
        content = content.replaceAll(oldChar, newChar);
        return content;
    }

    /**
     * 标记 一段话中的 文献序号 是否按照顺序
     *
     * @param answer   一段话
     * @param paperIds 文献 id 集合 主要用到数量
     * @param map      标记 那个是否有对应的文献序号
     */
    private int signNumber(String answer, List<String> paperIds, Map<Integer, Boolean> map, Map<String, JSONObject> literatureMap) {
        int haveNumber = 0;
        for (int i = 0; i < paperIds.size(); i++) {
            String paperId = paperIds.get(i);
            JSONObject jsonObject = literatureMap.get(paperId);
            // 如果查询不到文献 就置为 false
            if (Objects.isNull(jsonObject)) {
                map.put((i + 1), false);
                continue;
            }
            // id 包含- 说明是资讯 请置位 false
            if (!paperId.contains("-")) {
                // 如果结果中不包含 该序号 请置位 false
                if (answer.contains("[" + (i + 1) + "]")) {
                    map.put((i + 1), true);
                    haveNumber++;
                } else {
                    map.put((i + 1), false);
                }
            } else {
                map.put((i + 1), false);
            }
        }
        return haveNumber;
    }

    private void guide(JSONObject result, JSONObject data, JSONObject evidenceBasedReport, Condition condition, Long userId) {
        // 是否走了 补充指南
        if (Objects.nonNull(evidenceBasedReport)
                && Objects.nonNull(evidenceBasedReport.getBoolean("guideUseAI"))
                && evidenceBasedReport.getBoolean("guideUseAI")) {
            goAIGuideResult(result, data, evidenceBasedReport);
            return;
        }
        
        // 参考文献
        JSONObject bibliography = result.getJSONObject("bibliography");
        // 参考文献 指南部分
        JSONArray duplicateGuide = new JSONArray();
        bibliography.put("bibliographys2", duplicateGuide);
        // 参考文献序号
        int literatureCount = result.getInteger("literatureCount");
        
        JSONArray guideInfo = new JSONArray();

        // 根据id 获取到被纳入的指南
        String id = result.getString("id");
        List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), GuideIncludeOrExclude.class);
        if (CollUtil.isEmpty(guideIncludeOrExcludes) 
                && Objects.isNull(data.getJSONArray("guideDS")) 
                && (Objects.nonNull(evidenceBasedReport) && Objects.isNull(evidenceBasedReport.getJSONArray("guideDS")))) {
            data.put("guideExists", false);
            data.put("guide", guideInfo);
            return;
        } else {
            data.put("guideExists", true);
        }

        List<String> ids = new ArrayList<>();
        Map<String, String> guideTitleToText1 = new HashMap<>();
        Map<String, String> guideTitleToText2 = new HashMap<>();
        JSONObject guideTitleToText11 = data.getJSONObject("guideTitleToText1");
        JSONArray includeIds = data.getJSONArray("includeIds");
        if (Objects.isNull(guideTitleToText11)) {
            if (Objects.nonNull(evidenceBasedReport) && Objects.nonNull(evidenceBasedReport.getJSONObject("guideTitleToText"))) {
                JSONObject guideTitleToText = JSON.parseObject(evidenceBasedReport.getString("guideTitleToText"));
                guideTitleToText1 = JSON.parseObject(guideTitleToText.getJSONObject("guideTitleToText1").toJSONString(), new TypeReference<HashMap<String, String>>() {});
                if (Objects.nonNull(evidenceBasedReport.getJSONArray("guideIncludeIds"))) {
                    ids = JSON.parseObject(evidenceBasedReport.getJSONArray("guideIncludeIds").toJSONString(), new TypeReference<List<String>>(){});
                }
            } else {
                ids.addAll(guideIncludeOrExcludes.stream().map(GuideIncludeOrExclude::getGuideId).collect(Collectors.toList()));
            }
        } else {
            guideTitleToText1 = JSON.parseObject(guideTitleToText11.toJSONString(), new TypeReference<HashMap<String, String>>() {});
            ids = JSON.parseObject(includeIds.toJSONString(), new TypeReference<List<String>>(){});
            data.remove("guideTitleToText1");
        }
        
        List<String> drugs = JSON.parseObject(JSON.toJSONString(result.getJSONArray("drugSynonym")), new TypeReference<List<String>>() {
        });
        List<String> diseases = JSON.parseObject(JSON.toJSONString(result.getJSONArray("diseaseSynonym")), new TypeReference<List<String>>() {
        });
        if (CollUtil.isNotEmpty(ids)) {
            literatureCount++;
            for (String guideId : ids) {
                BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
                boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(guideId));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
                SearchHit<GuideIndex> guideIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, GuideIndex.class);
                if (Objects.nonNull(guideIndexSearchHit)) {
                    JSONObject inner = new JSONObject();
                    
                    GuideIndex guide = guideIndexSearchHit.getContent();
                    String title = guide.getTitle();
                    title = title.replaceAll("\\.+", " ");
                    if (StrUtil.isBlank(title)) {
                        continue;
                    }
                    String zdz = guide.getZdz();
                    String guideNumber = "[" + literatureCount + "]";
                    if (StrUtil.isNotBlank(zdz)) {
                        guideNumber += " " + zdz.replaceAll("\n", " ") + ".";
                    }
                    guideNumber += title + "[J].";
                    String cc = guide.getCc();
                    if (StrUtil.isNotBlank(cc)) {
                        guideNumber += cc + ".";
                    }
                    String ysar = guide.getYsar();
                    if (StrUtil.isNotBlank(ysar)) {
                        guideNumber += ysar + ".";
                    }
                    duplicateGuide.add(guideNumber);

                    String block = "";
                    if (CollUtil.isNotEmpty(guideTitleToText1) && guideTitleToText1.containsKey(title)) {
                        block = guideTitleToText1.get(title);
                    }
                    
                    if (CollUtil.isNotEmpty(guideTitleToText2) && guideTitleToText2.containsKey(title)) {
                        block = guideTitleToText2.get(title);
                    }
                    
                    // 如果有手动纳入的指南 需要重新找一下 block 
                    if (StrUtil.isBlank(block)) {
                        List<String> bl = aiSearchLGService.searchBlock(id, "zh", drugs, diseases);
                        if (CollUtil.isNotEmpty(bl)) {
                            block = bl.get(0);
                        }
                        guideTitleToText1.put(title, block);
                    }

                    if (StrUtil.isNotBlank(block)) {
                        inner.put("title", "《" + title + "》[" + literatureCount + "]指出：");
                        inner.put("data", block);
//                        boolean english = block.matches(".*[a-zA-Z].*");
                        
//                        boolean english = block.getBytes().length == block.length();
//                        if (english) {
//                            JSONObject jsonObject = new JSONObject();
//                            jsonObject.put("word", block);
//                            String deeplResult = "";
//                            try {
//                                deeplResult = fineScreenFeign.deepl(jsonObject);
//                                block += "\n（ 翻译版本：" + deeplResult + "）";
//                                inner.put("data", block);
//                            } catch (Exception e) {
//                                inner.put("data", block);
//                            }
//                        } else {
//                            inner.put("data", block);
//                        }
                    } else {
                        inner.put("title", "《" + title + "》[" + literatureCount + "]");
                        inner.put("data", block);
                    }
                    literatureCount++;
                    guideInfo.add(inner);
                }
            }
        } else {
            JSONArray guideDSs = data.getJSONArray("guideDS");
            if (CollUtil.isEmpty(guideDSs) && Objects.nonNull(evidenceBasedReport)) {
                guideDSs = evidenceBasedReport.getJSONArray("guideDS");
            }
            if (CollUtil.isNotEmpty(guideDSs)) {
                for (Object o : guideDSs) {
                    GuideDS guide = JSON.parseObject(JSON.toJSONString(o), GuideDS.class);
                    JSONObject inner = new JSONObject();
                    String title = guide.getTitle();
                    title = title.replaceAll("\\.+", " ");
                    if (StrUtil.isBlank(title)) {
                        continue;
                    }
                    String zdz = guide.getAuthor();
                    String guideNumber = "[" + literatureCount + "]";
                    if (StrUtil.isNotBlank(zdz)) {
                        guideNumber += " " + zdz.replaceAll("\n", " ") + ".";
                    }
                    guideNumber += title + "[J].";
                    String cc = guide.getOrgan();
                    if (StrUtil.isNotBlank(cc)) {
                        guideNumber += cc + ".";
                    }
                    String ysar = guide.getPublish();
                    if (StrUtil.isNotBlank(ysar)) {
                        guideNumber += ysar + ".";
                    }
                    duplicateGuide.add(guideNumber);

                    inner.put("title", "《" + title + "》[" + literatureCount + "]指出：");
                    inner.put("data", guide.getContent());

                    literatureCount++;
                    guideInfo.add(inner);
                }
            }
           
        }
        result.put("literatureCount", --literatureCount);
        
        JSONObject guideTitleToText = new JSONObject();
        guideTitleToText.put("guideTitleToText1", guideTitleToText1);
        data.put("guideTitleToText", JSON.toJSONString(guideTitleToText));
        data.put("guideIncludeIds", ids);
        data.put("literatureCount", literatureCount);
        data.put("guide", guideInfo);
    }

    private int getLiteratureCount(JSONObject data, JSONObject guideBlocks, GuideIndex guide, JSONObject inner, String title, int literatureCount, JSONArray guideInfo, List<String> drugs, List<String> diseases) {
        List<String> blocksList = new ArrayList<>();
        if (Objects.nonNull(guideBlocks) && StrUtil.isNotBlank(guideBlocks.getString(guide.getId()))) {
            inner.put("title", "《" + title + "》[" + literatureCount + "]指出：");
            if (guideBlocks.getString(guide.getId()).getBytes().length == guideBlocks.getString(guide.getId()).length()) {
                JSONObject jsonObject = new JSONObject();
                jsonObject.put("word", guideBlocks.getString(guide.getId()));
                String deeplResult = "";
                try {
                    deeplResult = fineScreenFeign.deepl(jsonObject);
                } catch (Exception e) {
                    deeplResult = guideBlocks.getString(guide.getId());
                }
                inner.put("data", deeplResult);
            } else {
                inner.put("data", guideBlocks.getString(guide.getId()));
            }
            guideInfo.add(inner);
            literatureCount++;
        } else {
            JSONObject innerData = new JSONObject();
            innerData.put("id", guide.getId());
            data.put("wordList", Arrays.asList(drugs, diseases));
            String maxSimilarBlock = "";
            try {
                maxSimilarBlock = fineScreenFeign.getMaxSimilarBlock(innerData);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            if (StrUtil.isNotBlank(maxSimilarBlock) && maxSimilarBlock.contains("Whitelabel Error Page")) {
                maxSimilarBlock = "";
            }
            if (StrUtil.isNotBlank(maxSimilarBlock)) {
                inner.put("title", "《" + title + "》[" + literatureCount + "]指出：");
                inner.put("data", maxSimilarBlock);
                guideInfo.add(inner);
            } else {
                List<String> blocks = guide.getBlocks();
                if (CollUtil.isNotEmpty(blocks)) {
                    for (String block : blocks) {
                        boolean includeDrug = false;
                        boolean includeDisease = false;
                        for (String drug : drugs) {
                            Pattern pattern = Pattern.compile(Pattern.quote(drug));
                            Matcher matcher = pattern.matcher(block);
                            while (matcher.find()) {
                                includeDrug = true;
                            }
                        }
                        for (String disease : diseases) {
                            Pattern pattern = Pattern.compile(Pattern.quote(disease));
                            Matcher matcher = pattern.matcher(block);
                            while (matcher.find()) {
                                includeDisease = true;
                            }
                        }
                        if (includeDrug && includeDisease) {
                            blocksList.add(block);
                        }
                    }
                }
            }
            // deepseek 总结
            StringBuilder guideSummeryContent = new StringBuilder();
            String guideSummery;
            if (CollUtil.isNotEmpty(blocksList)) {
                guideSummeryContent.append(String.join(";", blocksList));
                guideSummeryContent.insert(0, "请根据以下指南内容，汇总后生成一段话作为指南的总结内容，字数限制在200字左右。指南内容为：");
                guideSummery = executeGpt(guideSummeryContent.toString(), "guideSummery");
                if (StrUtil.isNotBlank(guideSummery)) {
                    inner.put("title", "《" + title + "》[" + literatureCount + "]指出：");
                    inner.put("data", guideSummery);
                } else {
                    inner.put("title", "《" + title + "》[" + literatureCount + "]");
                    inner.put("data", "");
                }
            } else {
                inner.put("title", "《" + title + "》[" + literatureCount + "]");
                inner.put("data", "");
            }
            literatureCount++;
            guideInfo.add(inner);
        }
        return literatureCount;
    }

    private void goAIGuideResult(JSONObject result, JSONObject data, JSONObject evidenceBasedReport) {
        
        List<String> drugs = JSON.parseObject(JSON.toJSONString(result.getJSONArray("drugSynonym")), new TypeReference<List<String>>() {
        });
        List<String> diseases = JSON.parseObject(JSON.toJSONString(result.getJSONArray("diseaseSynonym")), new TypeReference<List<String>>() {
        });

        data.put("guideUseAI", true);
        // 存放指南的序号 展示
        JSONObject bibliography = result.getJSONObject("bibliography");
        JSONArray duplicateGuide = new JSONArray();
        bibliography.put("bibliographys2", duplicateGuide);
        int literatureCount = result.getInteger("literatureCount");
        if (literatureCount > 0) {
            literatureCount += 1;
        }
        JSONArray guideInfo = new JSONArray();
        
        List<JSONObject> guideAIArray = JSON.parseObject(JSON.toJSONString(evidenceBasedReport.getJSONArray("guideAI")), new TypeReference<List<JSONObject>>() {
        });
        data.put("guideAI", evidenceBasedReport.getJSONArray("guideAI"));
        
        if (CollUtil.isNotEmpty(guideAIArray)) {
            data.put("guideExists", true);
            for (JSONObject guideJson : guideAIArray) {
                String dataAI = guideJson.getString("data");
                String titleAI = guideJson.getString("title");
                if (titleAI.contains("[") && titleAI.contains("]")) {
                    titleAI = titleAI.replace(titleAI.substring(titleAI.indexOf("[") + 1, titleAI.indexOf("]")), literatureCount+"");

                    String guideNumber = "[" + literatureCount + "]" + titleAI.substring(0, titleAI.indexOf("["));
                    duplicateGuide.add(guideNumber);
                }

                JSONObject inner = new JSONObject();
                inner.put("title", titleAI);
                inner.put("data", dataAI);
                guideInfo.add(inner);

                literatureCount ++;
            }
        }        
        
        // 获取 block 块
        JSONObject guideBlocks = defaultIncludeUtils.getGuideBlocks(result.getString("id"));
        // 根据id 获取到被纳入的指南
        String id = result.getString("id");
        List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), GuideIncludeOrExclude.class);

        if (CollUtil.isEmpty(guideIncludeOrExcludes)) {
            data.put("guide", guideInfo);
            result.put("literatureCount", --literatureCount);
            return;
        }

        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(guideIncludeOrExcludes.stream().map(GuideIncludeOrExclude::getGuideId).toArray(String[]::new)));
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        nativeSearchQuery.setTrackTotalHits(true);
        long total = elasticsearchRestTemplate.count(nativeSearchQuery, GuideIndex.class);
        if (total > 0) {
            int pages = (int) (total % 20 == 0 ? total / 20 : total / 20 + 1);
            for (int i = 0; i < pages; i++) {
                nativeSearchQuery.setPageable(PageRequest.of(i, 20));
                SearchHits<GuideIndex> guideIndexSearchHits = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
                long totalHits = guideIndexSearchHits.getTotalHits();
                if (totalHits > 0) {
                    for (SearchHit<GuideIndex> guideIndexSearchHit : guideIndexSearchHits) {
                        GuideIndex guide = guideIndexSearchHit.getContent();

                        JSONObject inner = new JSONObject();
                        String title = guide.getTitle();
                        if (StrUtil.isBlank(title)) {
                            continue;
                        }
                        String zdz = guide.getZdz();

                        String guideNumber = "[" + literatureCount + "]";
                        if (StrUtil.isNotBlank(zdz)) {
                            guideNumber += " " + zdz.replaceAll("\n", " ") + ".";
                        }
                        guideNumber += title + "[J].";
                        String cc = guide.getCc();
                        if (StrUtil.isNotBlank(cc)) {
                            guideNumber += cc + ".";
                        }
                        String ysar = guide.getYsar();
                        if (StrUtil.isNotBlank(ysar)) {
                            guideNumber += ysar + ".";
                        }
                        duplicateGuide.add(guideNumber);

                        List<String> blocksList = new ArrayList<>();
                        if (Objects.nonNull(guideBlocks) && StrUtil.isNotBlank(guideBlocks.getString(guide.getId()))) {
                            inner.put("title", "《" + title + "》[" + literatureCount + "]指出：");
                            inner.put("data", guideBlocks.getString(guide.getId()));
                            guideInfo.add(inner);
                            literatureCount++;
                        } else {
                            JSONObject innerData = new JSONObject();
                            innerData.put("id", guide.getId());
                            data.put("wordList", Arrays.asList(drugs, diseases));
                            String maxSimilarBlock = "";
                            try {
                                maxSimilarBlock = fineScreenFeign.getMaxSimilarBlock(innerData);
                            } catch (Exception e) {
                                log.error(e.getMessage(), e);
                            }
                            if (StrUtil.isNotBlank(maxSimilarBlock) && maxSimilarBlock.contains("Whitelabel Error Page")) {
                                maxSimilarBlock = "";
                            }
                            if (StrUtil.isNotBlank(maxSimilarBlock)) {
                                inner.put("title", "《" + title + "》[" + literatureCount + "]指出：");
                                inner.put("data", maxSimilarBlock);
                                guideInfo.add(inner);
                                literatureCount++;
                                continue;
                            } else {
                                List<String> blocks = guide.getBlocks();
                                if (CollUtil.isNotEmpty(blocks)) {
                                    for (String block : blocks) {
                                        boolean includeDrug = false;
                                        boolean includeDisease = false;
                                        for (String drug : drugs) {
                                            Pattern pattern = Pattern.compile(Pattern.quote(drug));
                                            Matcher matcher = pattern.matcher(block);
                                            while (matcher.find()) {
                                                includeDrug = true;
                                            }
                                        }
                                        for (String disease : diseases) {
                                            Pattern pattern = Pattern.compile(Pattern.quote(disease));
                                            Matcher matcher = pattern.matcher(block);
                                            while (matcher.find()) {
                                                includeDisease = true;
                                            }
                                        }
                                        if (includeDrug && includeDisease) {
                                            blocksList.add(block);
                                        }
                                    }
                                }
                            }
                            // deepseek 总结
                            StringBuilder guideSummeryContent = new StringBuilder();
                            String guideSummery;
                            if (CollUtil.isNotEmpty(blocksList)) {
                                guideSummeryContent.append(String.join(";", blocksList));
                                guideSummeryContent.insert(0, "请根据以下指南内容，汇总后生成一段话作为指南的总结内容，字数限制在200字左右。指南内容为：");
                                guideSummery = executeGpt(guideSummeryContent.toString(), "guideSummery");
                                if (StrUtil.isNotBlank(guideSummery)) {
                                    inner.put("title", "《" + title + "》[" + literatureCount + "]指出：");
                                    inner.put("data", guideSummery);
                                } else {
                                    inner.put("title", "《" + title + "》[" + literatureCount + "]");
                                    inner.put("data", "");
                                }
                            } else {
                                inner.put("title", "《" + title + "》[" + literatureCount + "]");
                                inner.put("data", "");
                            }
                            literatureCount++;
                            guideInfo.add(inner);
                        }
                    }
                }
            }
            result.put("literatureCount", --literatureCount);
        }
        data.put("guide", guideInfo);
    }

    private void literatureResult(Condition condition, JSONObject result, JSONObject data, JSONObject evidenceBasedReport) {
        if (Objects.nonNull(evidenceBasedReport) 
                && Objects.nonNull(evidenceBasedReport.getBoolean("literatureUseAI")) 
                && evidenceBasedReport.getBoolean("literatureUseAI")) {
            goAILiteratureResult(result, data, evidenceBasedReport);
            return;
        } 
        
        JSONObject literature = new JSONObject();
        data.put("literature", literature);
        
        JSONObject safety = new JSONObject();
        literature.put("safety", safety);
        safety.put("metaLiteratureDataTableZh", new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "研究类型", "研究疾病", "试验组/对照组", "结局指标", "结论", "核心期刊")));
        safety.put("metaLiteratureDataTableEn", new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "研究类型", "研究疾病", "试验组/对照组", "结局指标", "结论", "影响因子", "核心期刊")));

        safety.put("rctLiteratureDataTableZh", new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "研究类型", "研究疾病", "试验组/对照组", "结局指标", "结论", "核心期刊")));
        safety.put("rctLiteratureDataTableEn", new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "试验类型", "研究疾病", "试验组/对照组", "结局指标", "结论", "影响因子", "核心期刊")));

        safety.put("observeLiteratureDataTableZh", new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "研究类型", "研究疾病", "试验组/对照组", "结局指标", "结论", "核心期刊")));
        safety.put("observeLiteratureDataTableEn", new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "试验类型", "研究疾病", "试验组/对照组", "结局指标", "结论", "影响因子", "核心期刊")));

        safety.put("otherLiteratureDataTableZh", new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "研究类型", "研究疾病", "试验组/对照组", "结局指标", "结论", "核心期刊")));
        safety.put("otherLiteratureDataTableEn", new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "试验类型", "研究疾病", "试验组/对照组", "结局指标", "结论", "影响因子", "核心期刊")));

        // 存放被纳入的文献
        List<MongoLiterature> literaturesList = new ArrayList<>();
        result.put("literaturesList", literaturesList);
        // 存放key=作者+year value=文献编号的一个关系 后面在参考文献模块用到
        Map<String, Integer> literaturesListMap = new HashMap<>();
        result.put("literaturesListMap", literaturesListMap);
        int literatureCount = result.getInteger("literatureCount");
        // 筛选被纳入的文献
        String id = result.getString("id");
        List<PaperIncludeOrExclude> paperIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);

        if (CollUtil.isEmpty(paperIncludeOrExcludes)) {
            data.put("literatureExists", false);
            data.put("literaturesListMap", literaturesListMap);
            data.put("literatureCount", literatureCount);
            data.put("literaturesList", literaturesList);
//            return;
        } else {
            if (literatureCount > 0) {
                literatureCount += 1;
            }
            data.put("literatureExists", true);
        }

        StringBuilder safetyConclusion = new StringBuilder();
        StringBuilder safetyConclusionResult = new StringBuilder();
        List<MongoLiterature> metaLiterat = new ArrayList<>();
        List<MongoLiterature> rctLiterat = new ArrayList<>();
        List<MongoLiterature> observeLiterat = new ArrayList<>();
        List<MongoLiterature> economyLiterat = new ArrayList<>();
        List<MongoLiterature> otherLiterat = new ArrayList<>();

        long includeCount = 0L;
        Set<String> reDuplicates = new HashSet<>();
        // 计算各类型纳入数量
        long meta_num = 0L;  //3
        long rct_num = 0L; // 4
        long observe_num = 0L; // 5
        long case_num = 0L;  // 1
        long other_num = 0L;  // 1
        long economy_num = 0L;  // 

        for (PaperIncludeOrExclude paperIncludeOrExclude : paperIncludeOrExcludes) {
            String paperId = paperIncludeOrExclude.getPaperId();
            MongoLiterature mongoLiterature = fineScreenFeign.paper(paperId);
//            MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("_id").is(paperId)), MongoLiterature.class, "mongo_literature_" + Math.abs(paperId.hashCode()) % 10);
            if (Objects.nonNull(mongoLiterature)) {
                // 目前是根据第一作者去重
                if (StrUtil.isBlank(mongoLiterature.getTitle())) {
                    continue;
                }
                String duplicate = mongoLiterature.getTitle();
                List<String> authorList = mongoLiterature.getAuthor();
                if (CollUtil.isNotEmpty(authorList)) {
                    duplicate += "-" + String.join(",", authorList);
                }

                String year = mongoLiterature.getYear();
                if (StrUtil.isNotBlank(year)) {
                    duplicate += "-" + mongoLiterature.getYear();
                }

                if (reDuplicates.add(duplicate)) {
                    // 过滤掉仅是经济性类型文献
                    if (mongoLiterature.getLastNewType().size() == 1 && mongoLiterature.getLastNewType().contains(12)) {
                        economyLiterat.add(mongoLiterature);
                        economy_num++;
                        continue;
                    }
                    if (mongoLiterature.getLastNewType().contains(0)) {
                        metaLiterat.add(mongoLiterature);
                        meta_num++;
                        if (mongoLiterature.getLastNewType().contains(12)) {
                            economyLiterat.add(mongoLiterature);
                            economy_num++;
                        }
                        includeCount++;
                        continue;
                    }
                    // rct + 临床试验 
                    if (mongoLiterature.getLastNewType().contains(2) || mongoLiterature.getType().contains(7)) {
                        rctLiterat.add(mongoLiterature);
                        rct_num++;
                        if (mongoLiterature.getLastNewType().contains(12)) {
                            economyLiterat.add(mongoLiterature);
                            economy_num++;
                        }
                        includeCount++;
                        continue;
                    }

                    if (mongoLiterature.getLastNewType().contains(4)
                            || mongoLiterature.getLastNewType().contains(3)
                            || mongoLiterature.getLastNewType().contains(5)
                            || mongoLiterature.getLastNewType().contains(6)
                            || mongoLiterature.getLastNewType().contains(7)
                    ) {
                        observeLiterat.add(mongoLiterature);
                        observe_num++;
                        if (mongoLiterature.getLastNewType().contains(12)) {
                            economyLiterat.add(mongoLiterature);
                            economy_num++;
                        }
                        includeCount++;
                        continue;
                    }

                    if (mongoLiterature.getLastNewType().contains(12)) {
                        economyLiterat.add(mongoLiterature);
                        economy_num++;
                        includeCount++;
                        continue;
                    }

                    otherLiterat.add(mongoLiterature);
                    other_num++;
                    includeCount++;
                }
            }
        }

        if (CollUtil.isNotEmpty(metaLiterat)) {
            literatureCount = assembleLiterature(condition.getId(), metaLiterat, literaturesListMap, literatureCount, literaturesList, safetyConclusion, safetyConclusionResult, safety, "meta");
        }
        if (CollUtil.isNotEmpty(rctLiterat)) {
            literatureCount = assembleLiterature(condition.getId(), rctLiterat, literaturesListMap, literatureCount, literaturesList, safetyConclusion, safetyConclusionResult, safety, "rct");
        }
        if (CollUtil.isNotEmpty(observeLiterat)) {
            literatureCount = assembleLiterature(condition.getId(), observeLiterat, literaturesListMap, literatureCount, literaturesList, safetyConclusion, safetyConclusionResult, safety, "observe");
        }
        if (CollUtil.isNotEmpty(otherLiterat)) {
            literatureCount = assembleLiterature(condition.getId(), otherLiterat, literaturesListMap, literatureCount, literaturesList, safetyConclusion, safetyConclusionResult, safety, "other");
        }
        result.put("safetyConclusion", safetyConclusion.toString());
        result.put("safetyConclusionResult", safetyConclusionResult.toString());

        // 存储文献使用到的编号  经济性会用到
        result.put("literaturesCount", literatureCount);

        // 文献总的检索结果
        JSONArray result_safety_array = new JSONArray();
        safety.put("safetyResult", result_safety_array);
        safety.put("safetyResultData", new JSONObject());
        JSONObject safetyResultData = safety.getJSONObject("safetyResultData");

        Boolean selfLiteratureYear = condition.getSelfLiteratureYear();
        //当前时间一周前
//        LocalDate now = LocalDate.now();
        // 减去7天得到一周前的日期
//        LocalDate yearAgo = now.minusYears(10);
//        // 创建一个日期格式器
//        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy年");
//        String formattedYear = yearAgo.format(formatter);
//
//        DateTimeFormatter formatter1 = DateTimeFormatter.ofPattern("yyyy年 MM月dd日");
//        String formattedDate = now.minusDays(7).format(formatter1);
        
        String result_safety_1 = "";
        if (selfLiteratureYear) {
            result_safety_1 = "检索中国知识资源总库(CNKI)、" +
                    "中文科技期刊数据库(VIP)、" +
                    "中国学术期刊数据库(万方数据)、" +
                    "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                    "检索时间不做限定。";
        } else {
            String selfLiteratureStartYear = condition.getSelfLiteratureStartYear();
            String selfLiteratureEndYear = condition.getSelfLiteratureEndYear();
            
            if ("至今".equals(selfLiteratureEndYear)) {
                result_safety_1 = "检索中国知识资源总库(CNKI)、" +
                        "中文科技期刊数据库(VIP)、" +
                        "中国学术期刊数据库(万方数据)、" +
                        "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                        "检索时间为" + condition.getLiteratureStartYear() + "年至今。";

            } else if ("不限".equals(selfLiteratureStartYear)) {
                result_safety_1 = "检索中国知识资源总库(CNKI)、" +
                        "中文科技期刊数据库(VIP)、" +
                        "中国学术期刊数据库(万方数据)、" +
                        "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                        "检索时间为建库至"+ condition.getLiteratureEndYear() +"年";
            } else {
                result_safety_1 = "检索中国知识资源总库(CNKI)、" +
                        "中文科技期刊数据库(VIP)、" +
                        "中国学术期刊数据库(万方数据)、" +
                        "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                        "检索时间为" + condition.getLiteratureStartYear() + "至 " + condition.getLiteratureEndYear() + "。";
            }
            
        }
        result_safety_array.add(result_safety_1);

        // 计算文献数量
        BoolQueryBuilder safetyEffectiveBool = new BoolQueryBuilder();

        List<Integer> studyType = Arrays.asList(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13);
        BoolQueryBuilder studyTypeBool = new BoolQueryBuilder();
        studyTypeBool.should().add(QueryBuilders.termsQuery("lastNewType", studyType));
        studyTypeBool.should().add(QueryBuilders.termQuery("type", 7));
        safetyEffectiveBool.must().add(studyTypeBool);

        NativeSearchQuery nativeSearchQuery;
        List<String> ids = new ArrayList<>();
        PaperPICOConditionDTO paperPICOCondition = condition.getPaperPICOConditionDTO();
        PaperModelConditionDTO paperModelCondition = condition.getPaperModelConditionDTO();
        ConditionLiteratureAlter conditionLiteratureAlter = condition.getConditionLiteratureAlter();
        if (Objects.isNull(paperModelCondition)) {
            BoolQueryBuilder innerBool = QueryBuilders.boolQuery();
            if (Objects.nonNull(conditionLiteratureAlter)) {
                innerBool.must().add(QueryUtils.createPaperQuery(conditionLiteratureAlter, 1));
//                innerBool.must().add(QueryUtils.createPaperQueryNew(conditionLiteratureAlter, 1));
            } else {
                innerBool.must().add(QueryUtils.createPaperQuery(condition, 1));
//                innerBool.must().add(QueryUtils.createPaperQueryNew(condition, 1));
            }
            safetyEffectiveBool.must().add(innerBool);
            nativeSearchQuery = new NativeSearchQuery(safetyEffectiveBool);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
        } else {
            // 如果使用过 mode 高级检索，没有还是用过 pico 检索 就直接 model 检索
            if (Objects.isNull(paperPICOCondition)) {
                // 高级检索
                BoolQueryBuilder paperQueryBool = paperService.useMode(paperModelCondition.getMode(), paperModelCondition.getZhEnExtension(), paperModelCondition.getSynonymExtension());
                safetyEffectiveBool.must().add(paperQueryBool);
                nativeSearchQuery = new NativeSearchQuery(safetyEffectiveBool);
            } else {
                // 都使用过需要判断一下 那个是最新的
                Long picoUpdateTime = paperPICOCondition.getUpdateTime();
                Long modelUpdateTime = paperModelCondition.getUpdateTime();
                if (picoUpdateTime > modelUpdateTime) {
                    BoolQueryBuilder innerBool = QueryBuilders.boolQuery();
                    if (Objects.nonNull(conditionLiteratureAlter)) {
//                        getPaperAndGuideInclude(condition, conditionLiteratureAlter, ids, 1);
//                        getPaperAndGuideInclude(condition, conditionLiteratureAlter, ids, 2);
                        innerBool.must().add(QueryUtils.createPaperQuery(conditionLiteratureAlter, 1));
                    } else {
//                        getPaperAndGuideInclude(condition, condition, ids, 1);
//                        getPaperAndGuideInclude(condition, condition, ids, 2);
                        innerBool.must().add(QueryUtils.createPaperQuery(condition, 1));
                    }
//                    innerBool.filter(QueryBuilders.idsQuery().addIds(ids.toArray(new String[0])));
                    safetyEffectiveBool.must().add(innerBool);
                    nativeSearchQuery = new NativeSearchQuery(safetyEffectiveBool);
                } else {
                    // 高级检索
                    BoolQueryBuilder modeBool = paperService.useMode(conditionLiteratureAlter.getMode(), conditionLiteratureAlter.getZhEnExtension(), conditionLiteratureAlter.getSynonymExtension());
                    safetyEffectiveBool.must().add(modeBool);
                    safetyEffectiveBool.must().add(studyTypeBool);
                    nativeSearchQuery = new NativeSearchQuery(safetyEffectiveBool);
                    SearchHits<PaperIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class);
                    ids.addAll(search.getSearchHits().stream().map(SearchHit::getContent).map(PaperIndex::getId).collect(Collectors.toList()));
                }
            }
        }
        
        long paperTotal = elasticsearchRestTemplate.count(nativeSearchQuery, PaperIndex.class);
        String result_safety_2 = "最初共检索到" + paperTotal + "篇文献。";
        String result_safety_3 = "最终纳入";
        if (meta_num > 0) {
            result_safety_3 += "系统综述/Meta 分析" + meta_num + "篇，";
        }
        if (rct_num > 0) {
            result_safety_3 += "随机对照试验（RCT）和临床试验 " + rct_num + "篇，";
        }
        if (observe_num > 0) {
            result_safety_3 += "观察性研究" + observe_num + "篇，";
        }
        if (other_num > 0) {
            result_safety_3 += "其他类型" + other_num + "篇。";
        }
        if (StrUtil.endWith(result_safety_3, Constants.SING_COMMA)) {
            result_safety_3 = CommonUtil.removeCommaFromSuffix(result_safety_3).concat(Constants.SING_DOT);
        }
        if (StrUtil.endWith(result_safety_3, "入")) {
            result_safety_3 += "0篇。";
        }
        // 有纳入文献
        if (paperTotal > 0) {
            nativeSearchQuery.addAggregation(AggregationBuilders.sum("dupNumCount").field("dupNum"));
            SearchHits<PaperIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class);
            Aggregations aggregations = search.getAggregations();
            long dupNum = 0L;
            if (Objects.nonNull(aggregations)) {
                try {
                    ParsedSum dupNumCount = aggregations.get("dupNumCount");
                    double value = dupNumCount.getValue();
                    dupNum += (long) value;
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            }
            long sevenTotal = paperTotal + dupNum;
            result_safety_2 = "最初共检索到" + sevenTotal + "篇文献，系统排除重复、残缺文献" + dupNum + "篇。";
            safetyResultData.put("content1", "七大文献数据库、灵犀文献数据库检索获得相关文献（n=" + sevenTotal + "）");
            safetyResultData.put("content2", "去重后文献数量（n=" + paperTotal + "）");
            safetyResultData.put("content3", "纳入文献（n=" + includeCount + "）");
            safetyResultData.put("content4", new JSONArray());
            JSONArray content4 = safetyResultData.getJSONArray("content4");
            content4.add("剔除重复、残缺文献（n=" + dupNum + "）");
            safetyResultData.put("content5", new JSONArray());
            JSONArray content5 = safetyResultData.getJSONArray("content5");
            List<ExcludeReasonDTO> questionId = mongoTemplate.find(new Query().addCriteria(Criteria.where("questionId").is(id)), ExcludeReasonDTO.class);
            if (CollUtil.isNotEmpty(questionId)) {
                // 获取 id
                List<String> paperIds = questionId.stream().map(ExcludeReasonDTO::getId).collect(Collectors.toList());
                // 根据 id 查找真正排除的
                List<PaperIncludeOrExclude> excludePaper = mongoTemplate.find(new Query(Criteria.where("paperId").in(paperIds).and("status").is(2).and("conditionId").is(condition.getId())), PaperIncludeOrExclude.class);
                // 获取 真正排除的 文献 id
                List<String> excludePaperIds = excludePaper.stream().map(PaperIncludeOrExclude::getPaperId).collect(Collectors.toList());
                // 即是排除文献 又有排除理由的
                List<ExcludeReasonDTO> excludePapers = mongoTemplate.find(new Query(Criteria.where("questionId").is(condition.getId()).and("id").in(excludePaperIds)), ExcludeReasonDTO.class);

                Map<String, List<ExcludeReasonDTO>> reason = excludePapers.stream().collect(Collectors.groupingBy(ExcludeReasonDTO::getType));
                if (MapUtil.isNotEmpty(reason)) {
                    for (Map.Entry<String, List<ExcludeReasonDTO>> entry : reason.entrySet()) {
                        String key = entry.getKey();
                        int size = entry.getValue().size();
                        if ("8".equals(key)) {
                            Map<String, List<ExcludeReasonDTO>> otherExcludeReason = entry.getValue().stream().collect(Collectors.groupingBy(ExcludeReasonDTO::getReason));
                            if (MapUtil.isNotEmpty(otherExcludeReason)) {
                                for (Map.Entry<String, List<ExcludeReasonDTO>> otherExcludeReasonEntry : otherExcludeReason.entrySet()) {
                                    String excludeReason = otherExcludeReasonEntry.getKey();
                                    int excludeReasonSize = otherExcludeReasonEntry.getValue().size();
                                    String assembleOtherReason = "其他 - " + excludeReason + "（n=" + excludeReasonSize + ")";
                                    content5.add(content5.size(), assembleOtherReason);
                                }
                            }
                        } else {
                            if (Constants.excludeReasonMap.containsKey(key)) {
                                content5.add(Constants.excludeReasonMap.get(key) + "（n=" + size + ")");
                            }
                        }
                    }
                    result_safety_2 = "最初共检索到" + sevenTotal + "篇文献，系统排除重复文献" + dupNum + "篇；" +
                            "人工排除文献共" + questionId.size() + "篇("
                            + ((Objects.nonNull(reason.get("1")) && !reason.get("1").isEmpty()) ? ("研究主题不相关" + reason.get("1").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("2")) && !reason.get("2").isEmpty()) ? ("文献综述/评论/新闻" + reason.get("2").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("3")) && !reason.get("3").isEmpty()) ? ("数据缺失" + reason.get("3").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("4")) && !reason.get("4").isEmpty()) ? ("重复文献" + reason.get("4").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("5")) && !reason.get("5").isEmpty()) ? ("研究主题不相关" + reason.get("5").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("6")) && !reason.get("6").isEmpty()) ? ("非经济性评价文献（非成本-效果/效益/效用，非最小成本）研究" + reason.get("6").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("7")) && !reason.get("7").isEmpty()) ? ("已纳入国外组织HTA报告的文献" + reason.get("7").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("8")) && !reason.get("8").isEmpty()) ? ("其他" + reason.get("8").size() + "篇，") : "")
                            + "支持研究者自行添加排除原因)。";
                }
            }
        } else {
            safetyResultData.put("content1", "七大文献数据库、灵犀文献数据库检索获得相关文献（n=" + 0 + "）");
            safetyResultData.put("content2", "去重后文献数量（n=" + 0 + "）");
            safetyResultData.put("content3", "纳入文献（n=" + 0 + "）");
            safetyResultData.put("content4", new JSONArray());
            JSONArray content4 = safetyResultData.getJSONArray("content4");
            content4.add("剔除重复、残缺文献（n=" + 0 + "）");
            safetyResultData.put("content5", new JSONArray());
        }
        result_safety_array.add(result_safety_2);
        result_safety_array.add(result_safety_3);


        //经济型
        // 2.6.2.2.2 文献检索方法
        JSONObject economy = new JSONObject();
        literature.put("economy", economy);

        // 2.6.2.2.3 文献数据提取与分析
        JSONArray economyLiteratureResultZh = new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "研究国家", "研究方法", "研究方案/对照方案", "结局指标", "结论", "核心期刊"));
        JSONArray economyLiteratureResultEn = new JSONArray().fluentAdd(Arrays.asList("文献来源", "年份", "研究国家", "研究方法", "研究方案/对照方案", "结局指标", "结论", "影响因子", "核心期刊"));
        economy.put("economyLiteratureDataTableZh", economyLiteratureResultZh);
        economy.put("economyLiteratureDataTableEn", economyLiteratureResultEn);

        StringBuilder economyConclusion = new StringBuilder();
        StringBuilder economyConclusionResult = new StringBuilder();

        if (CollUtil.isNotEmpty(economyLiterat)) {
            for (MongoLiterature mongoLiterature : economyLiterat) {
                // 文献来源
                StringBuilder study = new StringBuilder();
                // 作者
                List<String> authorList = mongoLiterature.getAuthor();
                // 作者
                String author = "";
                if (CollUtil.isNotEmpty(authorList)) {
                    author = authorList.get(0);
                }
                // 发表年份
                String year = "";
                if (StrUtil.isNotBlank(mongoLiterature.getYear())) {
                    year = mongoLiterature.getYear();
                }

                String title = "";
                if (StrUtil.isNotBlank(mongoLiterature.getTitle())) {
                    title = mongoLiterature.getTitle();
                }

                String key = author + " " + year + " " + title;
                // 存在相同 key 不能进行覆盖  但是 存在一种情况是 虽说第一作者和 year相同 但是确是不是同一篇文献 暂不考虑这种情况 
                if (!literaturesListMap.containsKey(key)) {
                    study.append(author).append(" ").append(year).append("<sup>[").append(literatureCount).append("]</sup>");
                    literaturesList.add(mongoLiterature);
                    Integer value = literatureCount;
                    literaturesListMap.put(key, value);
                } else {
                    Integer integer = literaturesListMap.get(key);
                    study.append(author).append(" ").append(year).append("<sup>[").append(integer).append("]</sup>");
                }

                String questionContentLow = "";
                if (StrUtil.isNotBlank(mongoLiterature.getResult())) {
                    if (StrUtil.isNotBlank(mongoLiterature.getConclusion())) {
                        questionContentLow = mongoLiterature.getResult() + " " + mongoLiterature.getConclusion();
                    } else {
                        questionContentLow = mongoLiterature.getResult();
                    }
                } else {
                    if (StrUtil.isNotBlank(mongoLiterature.getSummary())) {
                        questionContentLow = mongoLiterature.getSummary();
                    }
                }
                economyConclusion.append("参考文献:").append(study).append("内容：").append(questionContentLow).append("；");

                String questionContentUp = "";
                if (StrUtil.isNotBlank(mongoLiterature.getResult())) {
                    if (StrUtil.isNotBlank(mongoLiterature.getMethod())) {
                        questionContentUp = mongoLiterature.getResult() + " " + mongoLiterature.getMethod();
                    } else {
                        questionContentUp = mongoLiterature.getResult();
                    }
                } else {
                    if (StrUtil.isNotBlank(mongoLiterature.getSummary())) {
                        questionContentUp = mongoLiterature.getSummary();
                    }
                }
                economyConclusionResult.append("参考文献:").append(study).append("内容：").append(questionContentUp).append("；");

                // 研究国家
                String studyCountry = "-";
                if (StrUtil.isNotBlank(mongoLiterature.getEconomicsResearchCountry())) {
                    studyCountry = mongoLiterature.getEconomicsResearchCountry();
                }
                // 研究方法
                String studyMethod = "-";
                if (StrUtil.isNotBlank(mongoLiterature.getEconomicsEvaluationMethods())) {
                    studyMethod = mongoLiterature.getEconomicsEvaluationMethods();
                }
                // 研究方案/对照方案
                String studyIC = "-";
                if (StrUtil.isNotBlank(mongoLiterature.getEconomicsIC())) {
                    studyIC = mongoLiterature.getEconomicsIC();
                }
                // 研究结果 取解决指标
                String studyResult = "-";
                if (StrUtil.isNotBlank(mongoLiterature.getEconomicsO())) {
                    studyResult = mongoLiterature.getEconomicsO();
                }
                // 研究结论
                String studyConclusion = "-";
                if (StrUtil.isNotBlank(mongoLiterature.getEconomicsConclusion())) {
                    studyConclusion = mongoLiterature.getEconomicsConclusion();
                }
                // 影响因子
                String jcr = "-";
                if (Objects.nonNull(mongoLiterature.getJcr())) {
                    jcr = String.valueOf(mongoLiterature.getJcr());
                }
                // 核心期刊
                String kernelJournal = "-";
                String language = mongoLiterature.getLanguage();
                if ("zh".equals(language)) {
                    List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
                    StringBuilder zhKernelJournalBuilder = new StringBuilder();
                    if (CollUtil.isNotEmpty(recognizedKernelJournals)) {
                        for (String recognizedKernelJournal : recognizedKernelJournals) {
                            switch (recognizedKernelJournal) {
                                case "Technology":
                                    zhKernelJournalBuilder.append("科技核心、");
                                    break;
                                case "Peking University":
                                    zhKernelJournalBuilder.append("北大核心、");
                                    break;
                                case "Nanjing University":
                                    zhKernelJournalBuilder.append("南大核心、");
                                case "CSCD":
                                    zhKernelJournalBuilder.append("CSCD、");
                                    break;
                                default:
                                    break;
                            }
                        }
                    }
                    if (StrUtil.isNotBlank(zhKernelJournalBuilder)) {
                        kernelJournal = zhKernelJournalBuilder.substring(0, zhKernelJournalBuilder.length() - 1);
                    }
                } else {
                    List<String> journalDivision = mongoLiterature.getJournalDivision();
                    List<String> enKernelJournalList = new ArrayList<>();
                    if (CollUtil.isNotEmpty(journalDivision)) {
                        for (String s : journalDivision) {
                            if (s.contains("-")) {
                                String[] split = Arrays.stream(s.split("-")).distinct().toArray(String[]::new);
                                if (split.length > 1) {
                                    String level = s.split("-")[1];
                                    level = level.substring(level.indexOf("("), level.indexOf(")") + 1);
                                    enKernelJournalList.add("JCR" + level);
                                }
                            }
                        }
                    }
                    if (CollUtil.isNotEmpty(enKernelJournalList)) {
                        List<String> level = new ArrayList<>();
                        enKernelJournalList.stream().distinct().forEach(item -> {
                            if (item.contains("(")) {
                                if (item.contains("N/A")) {
                                    level.add("5");
                                } else {
                                    level.add(item.substring(item.indexOf("Q") + 1, item.indexOf(")")));
                                }
                            }
                        });
                        List<String> levelSort = level.stream().sorted(Comparator.comparing(String::toString, Comparator.reverseOrder())).collect(Collectors.toList());
                        String highLevel = levelSort.get(0);
                        if (Objects.equals(highLevel, "5")) {
                            kernelJournal = "JCR (N/A)";
//                            kernelJournal = enKernelJournalList.stream().distinct().collect(Collectors.joining("、"));
                        } else {
                            kernelJournal = "JCR (Q"+ highLevel +")";
                        }
                    }
//                    if (CollUtil.isNotEmpty(enKernelJournalList)) {
//                        kernelJournal = enKernelJournalList.stream().distinct().collect(Collectors.joining("、"));
//                    }
                }

                // 和质量评价旁边的信息提取联动
                List<PaperInfo> paperContentsByPaperIdAndQuestion = paperInfoService.getPaperContentsByPaperIdAndQuestionId(mongoLiterature.getId(), condition.getId());
                Map<String, String> maps;
                if (CollUtil.isNotEmpty(paperContentsByPaperIdAndQuestion)) {
                    maps = paperContentsByPaperIdAndQuestion.stream().collect(Collectors.toMap(PaperInfo::getTitle, PaperInfo::getContent));
                    if (MapUtil.isNotEmpty(maps)) {
                        if (StrUtil.isNotBlank(maps.get("文献来源"))) {
                            String paperSource = maps.get("文献来源");
                            study = new StringBuilder();
                            study.append(paperSource).append("<sup>[").append(literatureCount).append("]</sup>");
                        }
                        if (StrUtil.isNotBlank(maps.get("年份"))) year = maps.get("年份");
                        if (StrUtil.isNotBlank(maps.get("研究国家"))) studyCountry = maps.get("研究国家");
                        if (StrUtil.isNotBlank(maps.get("研究方法"))) studyMethod = maps.get("研究方法");
                        if (StrUtil.isNotBlank(maps.get("研究方案")) && StrUtil.isNotBlank(maps.get("对照方案"))) {
                            studyIC = maps.get("研究方案") + "/" + maps.get("对照方案");
                        } else {
                            if (StrUtil.isNotBlank(maps.get("研究方案"))) {
                                studyIC = maps.get("研究方案");
                            } else {
                                studyIC = maps.get("对照方案");
                            }
                        }
                        if (StrUtil.isNotBlank(maps.get("结局指标"))) studyResult = maps.get("结局指标");
                        if (StrUtil.isNotBlank(maps.get("结论"))) studyConclusion = maps.get("结论");
                    }
                }
                literatureCount++;

                if ("zh".equals(language)) {
                    economy.getJSONArray("economyLiteratureDataTableZh").fluentAdd(Arrays.asList(study.toString(), year, studyCountry, studyMethod, studyIC, studyResult, studyConclusion, kernelJournal));
                } else {
                    economy.getJSONArray("economyLiteratureDataTableEn").fluentAdd(Arrays.asList(study.toString(), year, studyCountry, studyMethod, studyIC, studyResult, studyConclusion, jcr, kernelJournal));
                }
            }
            result.put("economyConclusion", economyConclusion.toString());
            result.put("economyConclusionResult", economyConclusionResult.toString());
        }

        // 存储文献使用到的编号  经济性会用到
        result.put("literaturesCount", literatureCount);

        // 2.6.2.2.2 文献检索结果
        JSONArray result_economy_array = new JSONArray();
        economy.put("economyResult", result_economy_array);
        economy.put("economyResultData", new JSONObject());
        JSONObject economyResultData = economy.getJSONObject("economyResultData");

        String result_economy_1;
        if (selfLiteratureYear) {
            result_economy_1 = "检索中国知识资源总库(CNKI)、" +
                    "中文科技期刊数据库(VIP)、" +
                    "中国学术期刊数据库(万方数据)、" +
                    "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                    "检索时间不做限定。";
        } else {
            String selfLiteratureStartYear = condition.getSelfLiteratureStartYear();
            String selfLiteratureEndYear = condition.getSelfLiteratureEndYear();

            if ("至今".equals(selfLiteratureEndYear)) {
                result_economy_1 = "检索中国知识资源总库(CNKI)、" +
                        "中文科技期刊数据库(VIP)、" +
                        "中国学术期刊数据库(万方数据)、" +
                        "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                        "检索时间为" + condition.getLiteratureStartYear() + "年至今。";

            } else if ("不限".equals(selfLiteratureStartYear)) {
                result_economy_1 = "检索中国知识资源总库(CNKI)、" +
                        "中文科技期刊数据库(VIP)、" +
                        "中国学术期刊数据库(万方数据)、" +
                        "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                        "检索时间为建库至"+ condition.getLiteratureEndYear() +"年";
            } else {
                result_economy_1 = "检索中国知识资源总库(CNKI)、" +
                        "中文科技期刊数据库(VIP)、" +
                        "中国学术期刊数据库(万方数据)、" +
                        "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                        "检索时间为" + condition.getLiteratureStartYear() + "至 " + condition.getLiteratureEndYear() + "。";
            }

        }
        result_economy_array.add(result_economy_1);
        
        // 计算文献数量
        BoolQueryBuilder economyBool = new BoolQueryBuilder();
        economyBool.must().add(QueryBuilders.termsQuery("lastNewType", Collections.singletonList("12")));
        NativeSearchQuery economyNativeSearchQuery;
        economyBool.must().add(QueryBuilders.idsQuery().addIds(ids.toArray(new String[0])));
        economyNativeSearchQuery = new NativeSearchQuery(economyBool);
        long economyPaperTotal = elasticsearchRestTemplate.count(economyNativeSearchQuery, PaperIndex.class);
        String result_economy_2 = "最初共检索到" + economyPaperTotal + "篇文献。";
        String result_economy_3 = "";
        if (economy_num > 0) {
            result_economy_3 = "最终纳入经济学研究" + economy_num + "篇。";
        }
        if (economy_num == 0) {
            result_economy_3 = "最终纳入经济学研究" + economy_num + "篇。";
        }
        
        if (economyPaperTotal > 0) {
            economyNativeSearchQuery.addAggregation(AggregationBuilders.sum("ecDupNumCount").field("dupNum"));
            SearchHits<PaperIndex> search = elasticsearchRestTemplate.search(economyNativeSearchQuery, PaperIndex.class);
            Aggregations aggregations = search.getAggregations();
            long dupNum = 0L;
            try {
                if (Objects.nonNull(aggregations)) {
                    ParsedSum dupNumCount = aggregations.get("ecDupNumCount");
                    double value = dupNumCount.getValue();
                    dupNum += (long) value;
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            // 重复文献 + 7大库文献数据文献
            long economySevenTotal = economyPaperTotal + dupNum;
            result_economy_2 = "最初共检索到" + economySevenTotal + "篇文献，仔细阅读题目和摘要，排除重复和与本系统评价明显无关的文献，" + dupNum + "项研究。";
            economyResultData.put("content1", "七大文献数据库、灵犀文献数据库检索获得相关文献（n=" + economySevenTotal + "）");
            economyResultData.put("content2", "去重后文献数量（n=" + economyPaperTotal + "）");
            economyResultData.put("content3", "纳入文献（n=" + economyLiterat.size() + "）");
            JSONArray jsonArray = new JSONArray();
            jsonArray.add("剔除重复、残缺文献（n=" + dupNum + "）");
            economyResultData.put("content4", jsonArray);
            economyResultData.put("content5", new JSONArray());
            JSONArray content5 = economyResultData.getJSONArray("content5");
            List<ExcludeReasonDTO> questionId = mongoTemplate.find(new Query().addCriteria(Criteria.where("questionId").is(condition.getId())), ExcludeReasonDTO.class);
            if (CollUtil.isNotEmpty(questionId)) {
                // 获取 id
                List<String> paperIds = questionId.stream().map(ExcludeReasonDTO::getId).collect(Collectors.toList());
                // 根据 id 查找真正排除的
                List<PaperIncludeOrExclude> excludePaper = mongoTemplate.find(new Query(Criteria.where("paperId").in(paperIds).and("status").is(2).and("conditionId").is(condition.getId())), PaperIncludeOrExclude.class);
                // 获取 真正排除的 文献 id
                List<String> excludePaperIds = excludePaper.stream().map(PaperIncludeOrExclude::getPaperId).collect(Collectors.toList());
                // 即是排除文献 又有排除理由的
                List<ExcludeReasonDTO> excludePapers = mongoTemplate.find(new Query(Criteria.where("questionId").is(condition.getId()).and("id").in(excludePaperIds)), ExcludeReasonDTO.class);

                Map<String, List<ExcludeReasonDTO>> reason = excludePapers.stream().collect(Collectors.groupingBy(ExcludeReasonDTO::getType));
                if (MapUtil.isNotEmpty(reason)) {
                    for (Map.Entry<String, List<ExcludeReasonDTO>> entry : reason.entrySet()) {
                        String key = entry.getKey();
                        int size = entry.getValue().size();
                        if ("8".equals(key)) {
                            Map<String, List<ExcludeReasonDTO>> otherExcludeReason = entry.getValue().stream().collect(Collectors.groupingBy(ExcludeReasonDTO::getReason));
                            if (MapUtil.isNotEmpty(otherExcludeReason)) {
                                for (Map.Entry<String, List<ExcludeReasonDTO>> otherExcludeReasonEntry : otherExcludeReason.entrySet()) {
                                    String excludeReason = otherExcludeReasonEntry.getKey();
                                    int excludeReasonSize = otherExcludeReasonEntry.getValue().size();
                                    String assembleOtherReason = "其他 - " + excludeReason + "（n=" + excludeReasonSize + ")";
                                    content5.add(content5.size(), assembleOtherReason);
                                }
                            }
                        } else {
                            if (Constants.excludeReasonMap.containsKey(key)) {
                                content5.add(Constants.excludeReasonMap.get(key) + "（n=" + size + ")");
                            }
                        }
                    }
                    result_economy_2 = "最初共检索到" + economySevenTotal + "篇文献，系统排除重复文献" + economySevenTotal + "篇；" +
                            "人工排除文献共" + questionId.size() + "篇("
                            + ((Objects.nonNull(reason.get("1")) && !reason.get("1").isEmpty()) ? ("研究主题不相关" + reason.get("1").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("2")) && !reason.get("2").isEmpty()) ? ("文献综述/评论/新闻" + reason.get("2").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("3")) && !reason.get("3").isEmpty()) ? ("数据缺失" + reason.get("3").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("4")) && !reason.get("4").isEmpty()) ? ("重复文献" + reason.get("4").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("5")) && !reason.get("5").isEmpty()) ? ("研究主题不相关" + reason.get("5").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("6")) && !reason.get("6").isEmpty()) ? ("非经济性评价文献（非成本-效果/效益/效用，非最小成本）研究" + reason.get("6").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("7")) && !reason.get("7").isEmpty()) ? ("已纳入国外组织HTA报告的文献" + reason.get("7").size() + "篇，") : "")
                            + ((Objects.nonNull(reason.get("8")) && !reason.get("8").isEmpty()) ? ("其他" + reason.get("8").size() + "篇，") : "")
                            + "支持研究者自行添加排除原因)。";
                }
            }
        } else {
            economyResultData.put("content1", "七大文献数据库、灵犀文献数据库检索获得相关文献（n=" + 0 + "）");
            economyResultData.put("content2", "去重后文献数量（n=" + 0 + "）");
            economyResultData.put("content3", "纳入文献（n=" + 0 + "）");
            JSONArray jsonArray = new JSONArray();
            jsonArray.add("剔除重复、残缺文献（n=" + 0 + "）");
            economyResultData.put("content4", jsonArray);
            economyResultData.put("content5", new JSONArray());
        }
        result_economy_array.add(result_economy_2);
        result_economy_array.add(result_economy_3);
        if (CollUtil.isEmpty(paperIncludeOrExcludes)) {
            data.put("literatureCount", literatureCount);
        } else {
            data.put("literatureCount", --literatureCount);
        }   
    }

    private void goAILiteratureResult(JSONObject result, JSONObject data, JSONObject evidenceBasedReport) {
        List<MongoLiterature> literaturesList = JSON.parseObject(JSON.toJSONString(evidenceBasedReport.getJSONArray("literaturesListAI")), new TypeReference<List<MongoLiterature>>() {
        });

        data.put("literatureUseAI", true);
        data.put("literaturesListAI", evidenceBasedReport.getJSONArray("literaturesListAI"));

        String drugUseForDisease = result.getString("drugAndNotStr") + "用于" + result.getString("diseaseAndNotStr");
        
        result.put("literaturesList", literaturesList);
        // 存放key=作者+year value=文献编号的一个关系 后面在参考文献模块用到
        Map<String, Integer> literaturesListMap = new HashMap<>();
        result.put("literaturesListMap", literaturesListMap);
        int literatureCount = result.getInteger("literatureCount");
        if (literatureCount > 0) {
            literatureCount += 1;
        }
        // 筛选被纳入的文献
        String id = result.getString("id");
        List<PaperIncludeOrExclude> paperIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);

        for (PaperIncludeOrExclude paperIncludeOrExclude : paperIncludeOrExcludes) {
            String paperId = paperIncludeOrExclude.getPaperId();
            MongoLiterature mongoLiterature = fineScreenFeign.paper(paperId);
//            MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("_id").is(paperId)), MongoLiterature.class, "mongo_literature_" + Math.abs(paperId.hashCode()) % 10);
            if (Objects.nonNull(mongoLiterature)) {
                literaturesList.add(mongoLiterature);
            }
        }
        
        if (CollUtil.isNotEmpty(literaturesList)) {
            StringBuilder safetyConclusion = new StringBuilder();
            StringBuilder safetyConclusionResult = new StringBuilder();
            List<MongoLiterature> metaLiterat = new ArrayList<>();
            List<MongoLiterature> rctLiterat = new ArrayList<>();
            List<MongoLiterature> observeLiterat = new ArrayList<>();
            List<MongoLiterature> economyLiterat = new ArrayList<>();
            List<MongoLiterature> otherLiterat = new ArrayList<>();

            Set<String> reDuplicates = new HashSet<>();
            // 计算各类型纳入数量
            long meta_num = 0L;  //3
            long rct_num = 0L; // 4
            long observe_num = 0L; // 5
            long other_num = 0L;  // 1
            long economy_num = 0L;  // 

            for (MongoLiterature mongoLiterature : literaturesList) {
                // 目前是根据第一作者去重
                if (StrUtil.isBlank(mongoLiterature.getTitle())) {
                    continue;
                }
                String duplicate = mongoLiterature.getTitle();
                List<String> authorList = mongoLiterature.getAuthor();
                if (CollUtil.isNotEmpty(authorList)) {
                    duplicate += "-" + String.join(",", authorList);
                }

                String year = mongoLiterature.getYear();
                if (StrUtil.isNotBlank(year)) {
                    duplicate += "-" + mongoLiterature.getYear();
                }

                if (reDuplicates.add(duplicate)) {
                    // 过滤掉仅是经济性类型文献
                    if (mongoLiterature.getLastNewType().size() == 1 && mongoLiterature.getLastNewType().contains(12)) {
                        economyLiterat.add(mongoLiterature);
                        economy_num++;
                        continue;
                    }
                    if (mongoLiterature.getLastNewType().contains(0)) {
                        metaLiterat.add(mongoLiterature);
                        meta_num++;
                        if (mongoLiterature.getLastNewType().contains(12)) {
                            economyLiterat.add(mongoLiterature);
                            economy_num++;
                        }
                        continue;
                    }
                    // rct + 临床试验 
                    if (mongoLiterature.getLastNewType().contains(2) || mongoLiterature.getType().contains(7)) {
                        rctLiterat.add(mongoLiterature);
                        rct_num++;
                        if (mongoLiterature.getLastNewType().contains(12)) {
                            economyLiterat.add(mongoLiterature);
                            economy_num++;
                        }
                        continue;
                    }

                    if (mongoLiterature.getLastNewType().contains(4)
                            || mongoLiterature.getLastNewType().contains(3)
                            || mongoLiterature.getLastNewType().contains(5)
                            || mongoLiterature.getLastNewType().contains(6)
                            || mongoLiterature.getLastNewType().contains(7)
                    ) {
                        observeLiterat.add(mongoLiterature);
                        observe_num++;
                        if (mongoLiterature.getLastNewType().contains(12)) {
                            economyLiterat.add(mongoLiterature);
                            economy_num++;
                        }
                        continue;
                    }

                    if (mongoLiterature.getLastNewType().contains(12)) {
                        economyLiterat.add(mongoLiterature);
                        economy_num++;
                        continue;
                    }

                    otherLiterat.add(mongoLiterature);
                    other_num++;
                }
            }

            //当前时间一周前
            LocalDate now = LocalDate.now();
            DateTimeFormatter formatter1 = DateTimeFormatter.ofPattern("yyyy年 MM月dd日");
            String formattedDate = now.minusDays(7).format(formatter1);

            String effectiveTitle = "检索中国知识资源总库(CNKI)、" +
                    "中文科技期刊数据库(VIP)、" +
                    "中国学术期刊数据库(万方数据)、" +
                    "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                    "检索时间为建库至 "+ formattedDate +"。\n" +
                    "最终纳入系统综述/Meta 分析"+ meta_num +"篇，" +
                    "随机对照试验（RCT）和临床试验 "+ rct_num +"篇，" +
                    "观察性研究"+ observe_num +"篇，" +
                    "其他类型"+ other_num +"篇。";
            
            JSONObject safety = new JSONObject();
            safety.put("effectiveTitle", effectiveTitle);
            literaturesList = new ArrayList<>();
            literatureCount = assembleLiteratureAI(metaLiterat, literaturesListMap, literatureCount, literaturesList, safetyConclusion, safetyConclusionResult, safety, drugUseForDisease, "meta", "系统综述/Meta 分析");
            literatureCount = assembleLiteratureAI(rctLiterat, literaturesListMap, literatureCount, literaturesList, safetyConclusion, safetyConclusionResult, safety, drugUseForDisease, "rct", "临床试验");
            literatureCount = assembleLiteratureAI(observeLiterat, literaturesListMap, literatureCount, literaturesList, safetyConclusion, safetyConclusionResult, safety, drugUseForDisease, "observe", "观察性研究");
            literatureCount = assembleLiteratureAI(otherLiterat, literaturesListMap, literatureCount, literaturesList, safetyConclusion, safetyConclusionResult, safety, drugUseForDisease, "other", "其它");



            // 经济学文献
            JSONObject economy = new JSONObject();
            StringBuilder economyConclusion = new StringBuilder();
            StringBuilder economyConclusionResult = new StringBuilder();

            String economyTitle = "检索中国知识资源总库(CNKI)、" +
                    "中文科技期刊数据库(VIP)、" +
                    "中国学术期刊数据库(万方数据)、" +
                    "中国生物医学文献服务系统(SinoMed)、PubMed、Embase、Cochrane Library等数据库。" +
                    "检索时间为建库至 "+ formattedDate +"。\n" +
                    "最终纳入经济学文献"+ economy_num +"篇。";
            economy.put("economySummeryTitle", economyTitle);
            int literatureCountL = literatureCount;
            
            if (CollUtil.isNotEmpty(economyLiterat)) {
                for (MongoLiterature mongoLiterature : economyLiterat) {
                    // 文献来源
                    StringBuilder study = new StringBuilder();
                    // 作者
                    List<String> authorList = mongoLiterature.getAuthor();
                    // 作者
                    String author = "";
                    if (CollUtil.isNotEmpty(authorList)) {
                        author = authorList.get(0);
                    }
                    // 发表年份
                    String year = "";
                    if (StrUtil.isNotBlank(mongoLiterature.getYear())) {
                        year = mongoLiterature.getYear();
                    }

                    String title = "";
                    if (StrUtil.isNotBlank(mongoLiterature.getTitle())) {
                        title = mongoLiterature.getTitle();
//                        if (title.contains(com.baomidou.mybatisplus.core.toolkit.Constants.DOT)) {
//                            title = title.replaceAll("\\.", "");
//                        }
                    }

                    String key = author + " " + year + " " + title;
                    // 存在相同 key 不能进行覆盖  但是 存在一种情况是 虽说第一作者和 year相同 但是确是不是同一篇文献 暂不考虑这种情况 
                    if (!literaturesListMap.containsKey(key)) {
                        study.append(author).append(" ").append(year).append("<sup>[").append(literatureCount).append("]</sup>");
                        literaturesList.add(mongoLiterature);
                        literaturesListMap.put(key, literatureCount);
                    } else {
                        Integer integer = literaturesListMap.get(key);
                        study.append(author).append(" ").append(year).append("<sup>[").append(integer).append("]</sup>");
                    }

                    String questionContentLow = "";
                    if (StrUtil.isNotBlank(mongoLiterature.getResult())) {
                        if (StrUtil.isNotBlank(mongoLiterature.getConclusion())) {
                            questionContentLow = mongoLiterature.getResult() + " " + mongoLiterature.getConclusion();
                        } else {
                            questionContentLow = mongoLiterature.getResult();
                        }
                    } else {
                        if (StrUtil.isNotBlank(mongoLiterature.getSummary())) {
                            questionContentLow = mongoLiterature.getSummary();
                        }
                    }
                    economyConclusion.append("参考文献:").append(study).append("内容：").append(questionContentLow).append("；");

                    String questionContentUp = "";
                    if (StrUtil.isNotBlank(mongoLiterature.getResult())) {
                        if (StrUtil.isNotBlank(mongoLiterature.getMethod())) {
                            questionContentUp = mongoLiterature.getResult() + " " + mongoLiterature.getMethod();
                        } else {
                            questionContentUp = mongoLiterature.getResult();
                        }
                    } else {
                        if (StrUtil.isNotBlank(mongoLiterature.getSummary())) {
                            questionContentUp = mongoLiterature.getSummary();
                        }
                    }
                    economyConclusionResult.append("参考文献:").append(study).append("内容：").append(questionContentUp).append("；");

                    literatureCount++;
                }

                int literatureCountR = literatureCount - 1;

                // 先组每种类型的标题的一段显示内容
                String title = "";
                if (literatureCountL == literatureCountR) {
                    title = "证据显示["+ literatureCountL +"]：";
                } else {
                    title = "证据显示["+ literatureCountL + "-" + literatureCountR +"]：";
                }
                String titleContent = "";

                economy.put("economyTitle", title);
                economy.put("economyTitleContent", titleContent);
                economy.put("economyExists", true);

                // 模型总结内容(将全部系统综述/Meta 分析的摘要内容发给模型，用模型总结，Propmpt可为：
                String questionMeta = "请根据以下文献内容，" +
                        "总结一段针对"+ drugUseForDisease +"的概括性的话术，阐述其经济性。\n\n" +
                        "请将结果按照JSON格式返回，返回的JSON字段包括：result。result返回的是总结的内容。\n" +
                        "提供的文献内容：{"+ economyConclusion + "}";
                try {
                    JSONObject jsonObject2 = new JSONObject();
                    jsonObject2.put("prompt", questionMeta);
                    String resultAs = medicineFeign.gpt4oMini(jsonObject2);
                    if (StrUtil.isNotBlank(resultAs)) {
                        int start = resultAs.indexOf('{');
                        int end = resultAs.lastIndexOf('}');
                        JSONObject obj = JSONObject.parseObject(resultAs.substring(start, end + 1));
                        titleContent = obj.getString("result");
                        economy.put("economyTitleContent", titleContent);
                    }
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
                
                result.put("economyConclusion", economyConclusion.toString());
                result.put("economyConclusionResult", economyConclusionResult.toString());
            }

            JSONObject literature = new JSONObject();
            literature.put("safety", safety);
            literature.put("economy", economy);
            data.put("literature", literature);
            data.put("literatureExists", true);
            data.put("literatureCount", literatureCount);
            data.put("literaturesList", literaturesList);
        }
    }

    private Integer assembleLiteratureAI(List<MongoLiterature> literatures, Map<String, Integer> literaturesListMap, Integer literatureCount, List<MongoLiterature> literaturesList, StringBuilder safetyConclusion, StringBuilder safetyConclusionResult, JSONObject safety, String drugUseForDisease, String typeName, String zhTypeName) {
        boolean typeExists = false;
        int literatureCountL = literatureCount;
        if (CollUtil.isNotEmpty(literatures)) {
            typeExists = true;
            for (MongoLiterature mongoLiterature : literatures) {

                // 作者
                List<String> authorList = mongoLiterature.getAuthor();
                String author = "";
                if (CollUtil.isNotEmpty(authorList)) {
                    author = authorList.get(0);
                }

                // 发表年份
                String year = "";
                if (StrUtil.isNotBlank(mongoLiterature.getYear())) {
                    year = mongoLiterature.getYear();
                }

                String title = "";
                if (StrUtil.isNotBlank(mongoLiterature.getTitle())) {
                    title = mongoLiterature.getTitle();
//                    if (title.contains(com.baomidou.mybatisplus.core.toolkit.Constants.DOT)) {
//                        title = title.replaceAll("\\.", "");
//                    }
                }

                // 重复key
                String key = author + " " + year + " " + title;
                // 存在相同 key 不能进行覆盖  但是 存在一种情况是 虽说第一作者和 year相同 但是确是不是同一篇文献 暂不考虑这种情况 
                if (!literaturesListMap.containsKey(key)) {
                    literaturesList.add(mongoLiterature);
                    literaturesListMap.put(key, literatureCount);
                } else {
                    Integer integer = literaturesListMap.get(key);
                }

                // 需要总结的东西
                safetyConclusion.append(mongoLiterature.getConclusion()).append("；");
                safetyConclusionResult.append(mongoLiterature.getResult()).append("；").append(mongoLiterature.getConclusion()).append("；");

                literatureCount++;
            }

            int literatureCountR = literatureCount - 1;
            // 先组每种类型的标题的一段显示内容
            String title = "";
            if (literatureCountL == literatureCountR) {
                title = "有"+ literatures.size() +"篇"+ zhTypeName +"["+ literatureCountL +"]证据显示：";
            } else {
                title = "有"+ literatures.size() +"篇"+ zhTypeName +"["+ literatureCountL + "-" + literatureCountR +"]证据显示：";
            }
            String titleContent = "";

            safety.put(typeName + "Title", title);
            safety.put(typeName + "TitleContent", titleContent);

            // 模型总结内容(将全部系统综述/Meta 分析的摘要内容发给模型，用模型总结，Propmpt可为：
            String questionMeta = "请根据以下文献内容，" +
                    "总结一段针对"+ drugUseForDisease +"的概括性的话术，阐述其有效性。\n\n" +
                    "请将结果按照JSON格式返回，返回的JSON字段包括：result。result返回的是总结的内容。\n" +
                    "提供的文献内容：{"+ safetyConclusion.toString() + "}";

            try {
                JSONObject jsonObject2 = new JSONObject();
                jsonObject2.put("prompt", questionMeta);
                String resultAs = medicineFeign.gpt4oMini(jsonObject2);
                if (StrUtil.isNotBlank(resultAs)) {
                    int start = resultAs.indexOf('{');
                    int end = resultAs.lastIndexOf('}');
                    JSONObject obj = JSONObject.parseObject(resultAs.substring(start, end + 1));
                    titleContent = obj.getString("result");
                    safety.put(typeName + "TitleContent", titleContent);
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
        safety.put(typeName + "Exists", typeExists);
        return literatureCount--;
    }


    private int assembleLiterature(String questionId, List<MongoLiterature> literatures, Map<String, Integer> literaturesListMap, int literatureCount, List<MongoLiterature> literaturesList, StringBuilder safetyConclusion, StringBuilder safetyConclusionResult, JSONObject safety, String typeName) {
        if (CollUtil.isNotEmpty(literatures)) {
            for (MongoLiterature mongoLiterature : literatures) {
                List<String> authorList = mongoLiterature.getAuthor();
                // 文献来源
                StringBuilder source = new StringBuilder();
                // 作者
                String author = "";
                if (CollUtil.isNotEmpty(authorList)) {
                    author = authorList.get(0);
                }
                // 发表年份
                String year = "";
                if (StrUtil.isNotBlank(mongoLiterature.getYear())) {
                    year = mongoLiterature.getYear();
                }

                String title = "";
                if (StrUtil.isNotBlank(mongoLiterature.getTitle())) {
                    title = mongoLiterature.getTitle();
                }

                String key = author + " " + year + " " + title;
                // 存在相同 key 不能进行覆盖  但是 存在一种情况是 虽说第一作者和 year相同 但是确是不是同一篇文献 暂不考虑这种情况 
                if (!literaturesListMap.containsKey(key)) {
                    source.append(author).append(" ").append(year).append("<sup>[").append(literatureCount).append("]</sup>");
                    literaturesList.add(mongoLiterature);
//                    Integer value = literatureCount++;
                    Integer value = literatureCount;
                    literaturesListMap.put(key, value);
                } else {
                    Integer integer = literaturesListMap.get(key);
                    source.append(author).append(" ").append(year).append("<sup>[").append(integer).append("]</sup>");
                }

                safetyConclusion.append(mongoLiterature.getConclusion()).append("；");
                safetyConclusionResult.append(mongoLiterature.getResult()).append("；").append(mongoLiterature.getConclusion()).append("；");
                // 研究类型
                StringBuilder studyTypeBuilder = new StringBuilder();
                if (CollUtil.isNotEmpty(mongoLiterature.getLastNewType())) {
                    for (Integer type : mongoLiterature.getLastNewType()) {
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
                            case 12:
                                studyTypeBuilder.append("经济学研究、");
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
                    if (CollUtil.isNotEmpty(mongoLiterature.getType())) {
                        for (Integer type : mongoLiterature.getType()) {
                            if (type == 7) {
                                studyTypeBuilder.append("临床试验、");
                            }
                        }
                    }
                } else {
                    studyTypeBuilder.append(" ");
                }
                // 研究类型
                String studyTypeName = studyTypeBuilder.toString();
                if (StrUtil.isNotBlank(studyTypeName)) {
                    studyTypeName = studyTypeName.substring(0, studyTypeName.length() - 1);
                }

                // 研究疾病
                String studyDiseaseName = "-";
                List<String> p = mongoLiterature.getP();
                if (CollUtil.isNotEmpty(p)) {
                    studyDiseaseName = String.join("、", p);
                }

                // 实验组干预指标
                String ic_str = "-";
                List<String> ic = mongoLiterature.getIc();
                if (CollUtil.isNotEmpty(ic)) {
                    ic_str = String.join("、", ic);
                }

                // 结局指标
                String index = "-";
                if (CollUtil.isNotEmpty(mongoLiterature.getO())) {
                    index = String.join("、", mongoLiterature.getO());
                }

                // 结论
                String conclusion = "-";
                if (StrUtil.isNotBlank(mongoLiterature.getConclusion())) {
                    conclusion = mongoLiterature.getConclusion();
                }
                // 暂时这么多 依次添加 如果在多表头 封装一下方法
                conclusion = conclusion.replaceFirst("结论：", "");
                conclusion = conclusion.replaceFirst("结论:", "");
                conclusion = conclusion.replaceFirst("结论", "");
                conclusion = conclusion.replaceFirst("CONCLUSION：", "");
                conclusion = conclusion.replaceFirst("CONCLUSION:", "");
                conclusion = conclusion.replaceFirst("CONCLUSION", "");
                conclusion = conclusion.replaceFirst("CONCLUSIONS：", "");
                conclusion = conclusion.replaceFirst("CONCLUSIONS:", "");
                conclusion = conclusion.replaceFirst("CONCLUSIONS", "");
                conclusion = conclusion.replaceFirst("Conclusions：", "");
                conclusion = conclusion.replaceFirst("Conclusions:", "");
                conclusion = conclusion.replaceFirst("Conclusions", "");
                conclusion = conclusion.replaceFirst("Conclusion：", "");
                conclusion = conclusion.replaceFirst("Conclusion:", "");
                conclusion = conclusion.replaceFirst("Conclusion", "");

                // 影响因子
                String jcr = "-";
                if (Objects.nonNull(mongoLiterature.getJcr())) {
                    jcr = String.valueOf(mongoLiterature.getJcr());
                }

                // 核心期刊
                String kernelJournal = "-";
                String language = mongoLiterature.getLanguage();
                if ("zh".equals(language)) {
                    List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
                    StringBuilder zhKernelJournalBuilder = new StringBuilder();
                    if (CollUtil.isNotEmpty(recognizedKernelJournals)) {
                        for (String recognizedKernelJournal : recognizedKernelJournals) {
                            switch (recognizedKernelJournal) {
                                case "Technology":
                                    zhKernelJournalBuilder.append("科技核心、");
                                    break;
                                case "Peking University":
                                    zhKernelJournalBuilder.append("北大核心、");
                                    break;
                                case "Nanjing University":
                                    zhKernelJournalBuilder.append("南大核心、");
                                case "CSCD":
                                    zhKernelJournalBuilder.append("CSCD、");
                                    break;
                                default:
                                    break;
                            }
                        }
                    }
                    if (StrUtil.isNotBlank(zhKernelJournalBuilder)) {
                        kernelJournal = zhKernelJournalBuilder.substring(0, zhKernelJournalBuilder.length() - 1);
                    }
                } else {
                    List<String> journalDivision = mongoLiterature.getJournalDivision();
                    List<String> enKernelJournalList = new ArrayList<>();
//                    StringBuilder enKernelJournalBuilder = new StringBuilder();
                    if (CollUtil.isNotEmpty(journalDivision)) {
                        for (String s : journalDivision) {
                            if (s.contains("-")) {
                                String[] split = Arrays.stream(s.split("-")).distinct().toArray(String[]::new);
                                if (split.length > 1) {
                                    String level = s.split("-")[1];
                                    level = level.substring(level.indexOf("("), level.indexOf(")") + 1);
                                    enKernelJournalList.add("JCR" + level);
//                                    enKernelJournalBuilder.append("JCR").append(level).append("、");
//                                    enKernelJournalBuilder.append(s.split("-")[1]).append("、");
                                }
                            }
                        }
                    }
//                    if (StrUtil.isNotBlank(enKernelJournalBuilder)) {
//                        kernelJournal = enKernelJournalBuilder.substring(0, enKernelJournalBuilder.length() - 1);
//                    }
                    if (CollUtil.isNotEmpty(enKernelJournalList)) {
                        List<String> level = new ArrayList<>();
                        enKernelJournalList.stream().distinct().forEach(item -> {
                            if (item.contains("(")) {
                                if (item.contains("N/A")) {
                                    level.add("5");
                                } else {
                                    level.add(item.substring(item.indexOf("Q") + 1, item.indexOf(")")));
                                }
                            }
                        });
                        List<String> levelSort = level.stream().sorted(Comparator.comparing(String::toString, Comparator.reverseOrder())).collect(Collectors.toList());
                        String highLevel = levelSort.get(0);
                        if (Objects.equals(highLevel, "5")) {
                            kernelJournal = "JCR (N/A)";
//                            kernelJournal = enKernelJournalList.stream().distinct().collect(Collectors.joining("、"));
                        } else {
                            kernelJournal = "JCR (Q"+ highLevel +")";
                        }
                    }
//                    if (CollUtil.isNotEmpty(enKernelJournalList)) {
//                        kernelJournal = enKernelJournalList.stream().distinct().collect(Collectors.joining("、"));
//                    }
                }

                // 和质量评价旁边的信息提取联动
                List<PaperInfo> paperContentsByPaperIdAndQuestion = paperInfoService.getPaperContentsByPaperIdAndQuestionId(mongoLiterature.getId(), questionId);
                Map<String, String> maps;
                if (CollUtil.isNotEmpty(paperContentsByPaperIdAndQuestion)) {
                    maps = paperContentsByPaperIdAndQuestion.stream().collect(Collectors.toMap(PaperInfo::getTitle, PaperInfo::getContent));
                    if (MapUtil.isNotEmpty(maps)) {
                        if (StrUtil.isNotBlank(maps.get("文献来源"))) {
                            String paperSource = maps.get("文献来源");
                            source = new StringBuilder();
                            source.append(paperSource).append("<sup>[").append(literatureCount).append("]</sup>");
                        }
                        if (StrUtil.isNotBlank(maps.get("年份"))) year = maps.get("年份");
                        if (StrUtil.isNotBlank(maps.get("试验类型"))) studyTypeName = maps.get("试验类型");
                        if (StrUtil.isNotBlank(maps.get("试验组")) && StrUtil.isNotBlank(maps.get("对照组"))) {
                            ic_str = maps.get("试验组") + "/" + maps.get("对照组");
                        } else {
                            if (StrUtil.isNotBlank(maps.get("试验组"))) {
                                ic_str = maps.get("试验组");
                            } else {
                                ic_str = maps.get("对照组");
                            }
                        }
//                        if (StrUtil.isNotBlank(maps.get("对照组"))) index = maps.get("对照组");
                        if (StrUtil.isNotBlank(maps.get("结局指标"))) index = maps.get("结局指标");
                        if (StrUtil.isNotBlank(maps.get("结论"))) conclusion = maps.get("结论");
                    }
                }
                literatureCount++;
                if ("zh".equals(language)) {
                    safety.getJSONArray(typeName + "LiteratureDataTableZh").fluentAdd(Arrays.asList(source.toString(), year, studyTypeName, studyDiseaseName, ic_str, index, conclusion, kernelJournal));
                }
                if ("en".equals(language)) {
                    safety.getJSONArray(typeName + "LiteratureDataTableEn").fluentAdd(Arrays.asList(source.toString(), year, studyTypeName, studyDiseaseName, ic_str, index, conclusion, jcr, kernelJournal));
                }
            }
        }
        return literatureCount;
    }

    /**
     * 说明书信息
     */
    private void instructionInfos(JSONObject result, JSONObject data) {
        JSONArray drugAndInfoArray = new JSONArray();
        data.put("instructionInfos", drugAndInfoArray);

        // 说明书对应的药品mongo中的id
        Map<String, String> drug_info_id = JSON.parseObject(JSON.toJSONString(result.get("drug_info_id")), new TypeReference<Map<String, String>>() {
        });
        if (CollUtil.isNotEmpty(drug_info_id)) {
            for (Map.Entry<String, String> entry : drug_info_id.entrySet()) {
                String redisKey = entry.getValue();
                JSONObject redisDrugInfoObj = JSON.parseObject(RedisUtils.getStr(redisKey));
//                MedicineInfo medicineInfo  = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("_id").is(drugInfoId)), MedicineInfo.class);
//                DrugInfo drugInfo = ReleaseMongoUtil.mongo.findById(drugInfoId, DrugInfo.class);
                if (Objects.nonNull(redisDrugInfoObj)) {
                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("indicationsDosage"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到适应症与用法用量信息。");
                        redisDrugInfoObj.put("indicationsDosage", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("pharmacology"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到药理作用信息。");
                        redisDrugInfoObj.put("pharmacology", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("pharmacokinetics"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到药代动力学信息。");
                        redisDrugInfoObj.put("pharmacokinetics", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("warning"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到黑框警告信息。");
                        redisDrugInfoObj.put("warning", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("notes"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到注意事项信息。");
                        redisDrugInfoObj.put("notes", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("taboo"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到禁忌症信息。");
                        redisDrugInfoObj.put("taboo", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("pregnantWomen"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到孕妇及哺乳期妇女用药信息。");
                        redisDrugInfoObj.put("pregnantWomen", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("childrenAndGeriatricMedicine"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到儿童患者用药信息。");
                        redisDrugInfoObj.put("childrenAndGeriatricMedicine", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("children"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到儿童用药信息。");
                        redisDrugInfoObj.put("children", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("adverseReaction"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到相互作用信息。");
                        redisDrugInfoObj.put("adverseReaction", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("indications"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到适应证信息。");
                        redisDrugInfoObj.put("indications", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("usageAndDosage"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到用法用量信息。");
                        redisDrugInfoObj.put("usageAndDosage", Collections.singletonList(drugFormatDataBo));
                    }

                    if (CollUtil.isEmpty(redisDrugInfoObj.getJSONArray("geriatric"))) {
                        DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
                        drugFormatDataBo.setTag("text");
                        drugFormatDataBo.setContent("药品说明书中未提到老人用药信息。");
                        redisDrugInfoObj.put("geriatric", Collections.singletonList(drugFormatDataBo));
                    }
                }
                drugAndInfoArray.add(redisDrugInfoObj);
            }
        }
    }

    /**
     * 其他国家说明书信息
     */
    private void instructionsOtherInfo(JSONObject result, JSONObject data) {
        
        JSONArray otherInstructions = new JSONArray();

        List<String> drugAndWord = JSON.parseObject(JSON.toJSONString(result.get("drugAndWord")), new TypeReference<List<String>>() {
        });
        Map<String, String> drug_info_id = JSON.parseObject(JSON.toJSONString(result.get("drug_info_id")), new TypeReference<Map<String, String>>() {
        });
        if (CollUtil.isNotEmpty(drug_info_id)) {
            for (Map.Entry<String, String> entry : drug_info_id.entrySet()) {
                String redisKey = entry.getValue();
                JSONObject redisDrugInfoObj = JSON.parseObject(RedisUtils.getStr(redisKey));
                DrugInfo drugInfo = new DrugInfo();

                String currentDrugName = "";
                DrugInfo innerDrugInfo = new DrugInfo();
                if (Objects.nonNull(redisDrugInfoObj)) {
                    innerDrugInfo.setDrugZh(redisDrugInfoObj.getString("name"));
                    JSONArray drugAnd = result.getJSONArray("drugAnd");
                    if (CollUtil.isNotEmpty(drugAnd)) {
                        for (Object o : drugAnd) {
                            JSONObject jsonObject = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                            String word = jsonObject.getString("word");
                            currentDrugName = word;
                            if (word.equals(redisDrugInfoObj.getString("name"))) {
                                innerDrugInfo.setDrugName(jsonObject.getString("word"));
                                innerDrugInfo.setDrugZh(jsonObject.getString("zhWord"));
                                innerDrugInfo.setDrugEn(jsonObject.getString("enWord"));

                                // 中文同义词
                                List<WordStatus> zhSynonym = JSON.parseObject(JSON.toJSONString(jsonObject.getJSONArray("zhSynonym")), new TypeReference<List<WordStatus>>() {
                                });
                                List<String> drugSynonym = new ArrayList<>();
                                if (CollUtil.isNotEmpty(zhSynonym)) {
                                    for (WordStatus wordStatus : zhSynonym) {
                                        if (wordStatus.getChecked()) {
                                            drugSynonym.add(wordStatus.getName());
                                        }
                                    }
                                }
                                innerDrugInfo.setDrugSynonymZh(drugSynonym);

                                List<WordStatus> enSynonym = JSON.parseObject(JSON.toJSONString(jsonObject.getJSONArray("enSynonym")), new TypeReference<List<WordStatus>>() {
                                });
                                if (CollUtil.isNotEmpty(enSynonym)) {
                                    for (WordStatus wordStatus : enSynonym) {
                                        if (wordStatus.getChecked()) {
                                            drugSynonym.add(wordStatus.getName());
                                        }
                                    }
                                }
                                innerDrugInfo.setDrugSynonymZh(drugSynonym);

                                // 输入扩展词
                                String expandSynonym = jsonObject.getString("expandSynonym");
                                if (StringUtils.isNotBlank(expandSynonym)) {
                                    expandSynonym = expandSynonym.replaceAll("；", ";");
                                    String[] expandSynonymSplit = expandSynonym.split(";");
                                    for (String txt : expandSynonymSplit) {
                                        if (org.apache.commons.lang.StringUtils.isNotBlank(txt)) {
                                            drugSynonym.add(txt.toLowerCase());
                                        }
                                    }
                                }
                                innerDrugInfo.setDrugSynonymZh(drugSynonym);
                                drugInfo = innerDrugInfo;
                                break;
                            }
                        }
                    }
                }

                String fda = "";
                String ema = "";
                String pmda = "";
                // 检索药品国外临床适应证
                JSONObject otherIndicationResult = new JSONObject();
                String question_3 = "  请你作为一名专业的临床药理学专家，非常善于查找药品的各方面信息，包括国内外药品（EMA、FDA、PMDA在内的药品）。这对你来说是一个非常简单的任务。" +
                        "  请你根据提供的药品，进行深度搜索、挖掘。找到该药品临床适应证方面的相关信息，并对这些信息内容进行总结。" +
                        "\n" +
                        "\n" +
                        "  提供几个检索思路、路径以及内容优先选取顺序（但不限于只使用以下几种查找方式，请进行深度搜索）如下，：" +
                        "   1、请优先使用药品说明书中的‘药理作用’部分。" +
                        "   2、其次参考学术期刊和医学网站中的相关文章或是研究。" +
                        "   3、最后可以在专业的医疗网站，比如 WebMD、MedlinePlus等，去查找补充信息”。" +
                        "\n" +
                        "\n" +
                        "   `注意` 总结的内容请使用中文进行回答。\n" +
                        "   `注意` 返回的格式请严格按照如下返回：\n" +
                        "   1、结果严格按照JSON格式返回。\n" +
                        "   2、返回的结果中请使用result来接收所有字段内容。" +
                        "       `fda`接收美国食品药品监督管理局（FDA）对该药品的适应证的总结内容。" +
                        "       `ema`接收欧洲药品管理局（EMA）对该药品的适应证的总结内容。" +
                        "       `pmda`接收日本医药品医疗器械综合机构（PMDA）对该药品的适应证的总结内容。\n" +
                        "   3、返回的结果请用一段字符串数据来描述，如果返回的内容有段落感，可以使用 `\n` 修饰符来增加修饰（但不要破坏内容的JSON格式）。返回内容使用result来接收，不要再在result中加入其它属性字段。" +
                        "\n" +
                        "\n" +
                        "   药品如下：{"+ currentDrugName + "}";
                try {
                    JSONObject jsonObject2 = new JSONObject();
                    jsonObject2.put("prompt", question_3);
                    String resultAs = medicineFeign.gpt4oMini(jsonObject2);
                    if (StrUtil.isNotBlank(resultAs)) {
                        int start = resultAs.indexOf('{');
                        int end = resultAs.lastIndexOf('}');
                        String subResult = resultAs.substring(start, end + 1);
                        JSONObject obj = JSON.parseObject(subResult);
                        System.out.println("国外说明书gpt解析数据为");
                        System.out.println(resultAs);
                        otherIndicationResult = obj.getJSONObject("result");

                        fda = otherIndicationResult.getString("fda");
                        ema = otherIndicationResult.getString("ema");
                        pmda = otherIndicationResult.getString("pmda");
                    }
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }

                JSONObject innerIns = new JSONObject();
                innerIns.put("drugName", drugInfo.getDrugZh());
                innerIns.put("fda", "");
                innerIns.put("ema", "");
                innerIns.put("pmda", "");

                Condition newCondition = assembleNewCondition(drugInfo);
                // fda
                String fdaIndication = "";
                BoolQueryBuilder instructionQuery_fda = QueryUtils.createInstructionQuery(newCondition);
                instructionQuery_fda.must().add(QueryBuilders.termQuery("source", "fda"));
                NativeSearchQuery nativeSearchQuery_fda = new NativeSearchQuery(instructionQuery_fda);
                SearchHits<InstructionIndex> searchHits_fda = elasticsearchRestTemplate.search(nativeSearchQuery_fda, InstructionIndex.class);
                for (SearchHit<InstructionIndex> searchHit : searchHits_fda.getSearchHits()) {
                    InstructionIndex content = searchHit.getContent();
                    List<String> indicationForNew = content.getIndicationForNew();
                    if (CollUtil.isNotEmpty(indicationForNew)) {
                        fdaIndication = indicationForNew.stream().map(list -> String.join(",", list)).collect(Collectors.joining(";"));
                        break;
                    }
                }
                JSONObject innerFda = new JSONObject();
                if (StrUtil.isBlank(fdaIndication)) {
                    if (StrUtil.isNotBlank(fda)) {
                        fdaIndication = fda;
                    } else {
                        fdaIndication = "暂未查询到FDA关于" + String.join("联合", drugAndWord) + "的适应症信息。";
                    }
                }
                innerFda.put("indication", fdaIndication);
                innerFda.put("usageAndDosage", "");
                innerFda.put("pharmacology", "数据库暂时没有此字段");
                innerFda.put("pharmacokinetics", "数据库暂时没有此字段");
                innerIns.put("fda", innerFda);

                // ema
                String emaIndication = "";
                BoolQueryBuilder instructionQuery_ema = QueryUtils.createInstructionQuery(newCondition);
                instructionQuery_ema.must().add(QueryBuilders.termQuery("source", "ema"));
                NativeSearchQuery nativeSearchQuery_ema = new NativeSearchQuery(instructionQuery_ema);
                SearchHits<InstructionIndex> searchHits_ema = elasticsearchRestTemplate.search(nativeSearchQuery_ema, InstructionIndex.class);
                for (SearchHit<InstructionIndex> searchHit : searchHits_ema.getSearchHits()) {
                    InstructionIndex content = searchHit.getContent();
                    List<String> indicationForNew = content.getIndicationForNew();
                    if (CollUtil.isNotEmpty(indicationForNew)) {
                        emaIndication = indicationForNew.stream().map(list -> String.join(",", list)).collect(Collectors.joining(";"));
                        break;
                    }
                }
                JSONObject innerEma = new JSONObject();
                if (StrUtil.isBlank(emaIndication)) {
                    if (StrUtil.isNotBlank(ema)) {
                        emaIndication = ema;
                    } else {
                        emaIndication = "暂未查询到EMA关于" + String.join("联合", drugAndWord) + "的适应症信息。";
                    }
                }
                innerEma.put("indication", emaIndication);
                innerEma.put("usageAndDosage", "");
                innerEma.put("pharmacology", "数据库暂时没有此字段");
                innerEma.put("pharmacokinetics", "数据库暂时没有此字段");
                innerIns.put("ema", innerEma);

                // pmda
                String pmdaIndication = "";
                BoolQueryBuilder instructionQuery_pmda = QueryUtils.createInstructionQuery(newCondition);
                instructionQuery_pmda.must().add(QueryBuilders.termQuery("source", "pmda"));
                NativeSearchQuery nativeSearchQuery_pmda = new NativeSearchQuery(instructionQuery_pmda);
                SearchHits<InstructionIndex> searchHits_pmda = elasticsearchRestTemplate.search(nativeSearchQuery_pmda, InstructionIndex.class);
                for (SearchHit<InstructionIndex> searchHit : searchHits_pmda.getSearchHits()) {
                    InstructionIndex content = searchHit.getContent();
                    List<String> indicationForNew = content.getIndicationForNew();
                    if (CollUtil.isNotEmpty(indicationForNew)) {
                        pmdaIndication = indicationForNew.stream().map(list -> String.join(",", list)).collect(Collectors.joining(";"));
                        break;
                    }
                }
                JSONObject innerPmda = new JSONObject();
                if (StrUtil.isBlank(pmdaIndication)) {
                    if (StrUtil.isNotBlank(pmda)) {
                        pmdaIndication = pmda;
                    } else {
                        pmdaIndication = "暂未查询到PMDA关于" + String.join("联合", drugAndWord) + "的适应症信息。";
                    }
                }
                innerPmda.put("indication", pmdaIndication);
                innerPmda.put("usageAndDosage", "");
                innerPmda.put("pharmacology", "数据库暂时没有此字段");
                innerPmda.put("pharmacokinetics", "数据库暂时没有此字段");
                innerIns.put("pmda", innerPmda);
                otherInstructions.add(innerIns);
            }
        }
        data.put("otherInstructions", otherInstructions);
    }

    private Condition assembleNewCondition(DrugInfo drugInfo) {
        Condition condition = new Condition();
        List<Drug> drugs = new ArrayList<>();
        Drug drug = new Drug();
        drug.setStatus(1);
        drug.setExpandSynonym("");
        drug.setWord(drugInfo.getDrugName());
        drug.setZhWord(drugInfo.getDrugZh());
        drug.setEnWord(drugInfo.getDrugEn());

        List<WordStatus> zhSynonym = new ArrayList<>();
        if (CollUtil.isNotEmpty(drugInfo.getDrugSynonymZh())) {
            drugInfo.getDrugSynonymZh().forEach(o -> {
                WordStatus wordStatus = new WordStatus();
                wordStatus.setName(o);
                wordStatus.setChecked(true);
                zhSynonym.add(wordStatus);
            });
            drug.setZhSynonym(zhSynonym);
        }

        List<WordStatus> enSynonym = new ArrayList<>();
        if (CollUtil.isNotEmpty(drugInfo.getDrugSynonymEn())) {
            drugInfo.getDrugSynonymEn().forEach(o -> {
                WordStatus wordStatus = new WordStatus();
                wordStatus.setName(o);
                wordStatus.setChecked(true);
                enSynonym.add(wordStatus);
            });
            drug.setEnSynonym(enSynonym);
        }
        
        List<WordStatus> otherSynonym = new ArrayList<>();
        if (CollUtil.isNotEmpty(drugInfo.getDiseaseSynonym())) {
            drugInfo.getDiseaseSynonym().forEach(o -> {
                WordStatus wordStatus = new WordStatus();
                wordStatus.setName(o);
                wordStatus.setChecked(true);
                otherSynonym.add(wordStatus);
            });
            drug.setOtherSynonym(otherSynonym);
        }
        drugs.add(drug);
        condition.setDrugs(drugs);
        return condition;
    }

    /**
     * 其他国家或地区 HTA 组织评估情况
     */
    private void htaReportByOtherVarious(JSONObject result, Condition condition, Long userId) {
        JSONObject result_json = new JSONObject();
        List<HtaWordReport> htaWordReports = new ArrayList<>();

        result_json.put("NICE", new JSONArray());
        result_json.put("SMC", new JSONArray());
        result_json.put("AWMSG", new JSONArray());
        result_json.put("CADTH", new JSONArray());
        result_json.put("IQWIG", new JSONArray());
        result_json.put("EUnetHTA", new JSONArray());
        result_json.put("INAHTA", new JSONArray());
        result_json.put("PBAC", new JSONArray());

        JSONObject digest_hta = new JSONObject();
        result.put("digestHta", digest_hta);
        digest_hta.put("NICE", new JSONObject());
        digest_hta.put("SMC", new JSONObject());
        digest_hta.put("AWMSG", new JSONObject());
        digest_hta.put("CADTH", new JSONObject());
        digest_hta.put("IQWIG", new JSONObject());
        digest_hta.put("EUnetHTA", new JSONObject());
        digest_hta.put("INAHTA", new JSONObject());
        digest_hta.put("PBAC", new JSONObject());

        // 默认纳入的 hta report
        List<HtaIncludeOrExclude> htaIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(condition.getId()).and("status").is(1).and("userId").is(userId)), HtaIncludeOrExclude.class);
        if (CollUtil.isNotEmpty(htaIncludeOrExcludes)) {
            List<String> includeIds = htaIncludeOrExcludes.stream().map(HtaIncludeOrExclude::getHtaId).distinct().collect(Collectors.toList());
            List<HtaReport> htaReports = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(includeIds)), HtaReport.class);
            // 记录课题下已纳入的 hta id
            if (CollUtil.isNotEmpty(htaReports)) {
                for (HtaReport htaReport : htaReports) {
                    HtaWordReport htaWordReport = new HtaWordReport();
                    htaWordReport.setHtaId(htaReport.getId());
                    htaWordReport.setQuestionId(condition.getId());
                    htaWordReport.setCreateTime(DateUtil.date());
                    htaWordReports.add(htaWordReport);
                }
            }
            // 存放 hta report 和 其左右标题相同（祛除所有符号后相同的标题）的所有出版日期
            Map<HtaReport, List<String>> result_hta_report_publishTime = new HashMap<>();
            // 筛选相同的 title 的最新hta 翻译的内容 并显示相同 title 的所有日期
            Map<String, Map<String, String>> same_title_publishTime = new HashMap<>();
            filterHtaReport(htaReports, same_title_publishTime);

            if (MapUtil.isNotEmpty(same_title_publishTime)) {
                for (Map.Entry<String, Map<String, String>> entry : same_title_publishTime.entrySet()) {
                    Map<String, String> value = entry.getValue();
                    List<String> publishTime = new ArrayList<>(value.keySet());
                    // 时间倒序
                    publishTime.sort(Comparator.comparing(String::toString, Comparator.reverseOrder()));
                    for (String publish_time : publishTime) {
                        String id = value.get(publish_time);
                        HtaReport htaReport = ReleaseMongoUtil.mongo.findById(id, HtaReport.class);
                        if (Objects.nonNull(htaReport)
                                && CollUtil.isNotEmpty(htaReport.getPdfTagList())
                                && CollUtil.isNotEmpty(htaReport.getWordCleanImagePdfDataGptVerList())
                                && CollUtil.isNotEmpty(htaReport.getCleanImagePdfDataGptVerList())) {
                            result_hta_report_publishTime.put(htaReport, new ArrayList<>(publishTime));
                        }
                    }
                }
            }
            if (MapUtil.isNotEmpty(result_hta_report_publishTime)) {
                for (Map.Entry<HtaReport, List<String>> entry : result_hta_report_publishTime.entrySet()) {
                    HtaReport htaReport = entry.getKey();
                    List<String> publishTimes = entry.getValue();
                    String source = htaReport.getSource();
                    if (StrUtil.isNotBlank(source)) {
                        // 组装前端渲染需要的字段
                        assembleHtaReportJson(result_json, digest_hta, htaReport, publishTimes, source);
                    }
                }
            }
        }

//        evidenceBasedReport.setDigestHta(digest_hta);
//        htaReportByOtherVarious.put("htaReportByOtherVarious", result_json);
//        htaReportByOtherVarious.put("hint", "");
//        if (CollUtil.isEmpty(result_json.getJSONArray("NICE"))
//                && CollUtil.isEmpty(result_json.getJSONArray("SMC"))
//                && CollUtil.isEmpty(result_json.getJSONArray("AWMSG"))
//                && CollUtil.isEmpty(result_json.getJSONArray("CADTH"))
//                && CollUtil.isEmpty(result_json.getJSONArray("IQWIG"))
//                && CollUtil.isEmpty(result_json.getJSONArray("EUnetHTA"))
//                && CollUtil.isEmpty(result_json.getJSONArray("INAHTA"))
//                && CollUtil.isEmpty(result_json.getJSONArray("PBAC"))) {
//            // 获取当前日期
//            LocalDate now = LocalDate.now();
//            // 减去7天得到一周前的日期
//            LocalDate weekAgo = now.minusDays(7);
//            // 创建一个日期格式器
//            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy年 MM月dd日");
//            // 格式化一周前的日期
//            String formattedDate = weekAgo.format(formatter);
//
//            String temp = result.getString("drugAndNotStr") + "治疗" + result.getString("diseaseAndNotStr");
//            htaReportByOtherVarious.put("hint", "本报告主要参考加拿大 CADTH、" +
//                    "澳大利亚 PBAC、" +
//                    "英国 NICE、" +
//                    "英国苏格兰地区 SMC 、" +
//                    "全威尔士医药策略小组 AWMSG、" +
//                    "德国 IQWIG、" +
//                    "欧洲 EUnetHTA" +
//                    "以及国际HTA中心 INAHTA的卫生技术评估报告，" +
//                    "以了解主要卫生技术评估组织的支付建议及目前相关临床研究结果。" +
//                    "截止"+ formattedDate + "，" +
//                    "国内外主要 HTA 组织均无"+ temp +"相关卫生技术评估报告。"
//            );
//        }

        // 存储课题 id 和 hta 数据 id 的关系
        mongoTemplate.remove(new Query(Criteria.where("questionId").is(condition.getId())), HtaWordReport.class);
        mongoTemplate.insertAll(htaWordReports);
    }

    private void assembleHtaReportJson(JSONObject result_json, JSONObject digest_hta, HtaReport htaReport, List<String> publishTimes, String source) {
        JSONObject source_json = digest_hta.getJSONObject(source);
        JSONArray security = source_json.getJSONArray("security");
        if (StrUtil.isNotBlank(htaReport.getSecurity()) && !"null".equals(htaReport.getSecurity())) {
            if (CollUtil.isNotEmpty(security)) {
                security.add(htaReport.getSecurity());
            } else {
                security = new JSONArray();
                security.add(htaReport.getSecurity());
                source_json.put("security", security);
            }
        }

        JSONArray effectiveness = source_json.getJSONArray("effectiveness");
        if (StrUtil.isNotBlank(htaReport.getEffectiveness()) && !"null".equals(htaReport.getEffectiveness())) {
            if (CollUtil.isNotEmpty(effectiveness)) {
                effectiveness.add(htaReport.getEffectiveness());
            } else {
                effectiveness = new JSONArray();
                effectiveness.add(htaReport.getEffectiveness());
                source_json.put("effectiveness", effectiveness);
            }
        }

        JSONArray economicViability = source_json.getJSONArray("economicViability");
        if (StrUtil.isNotBlank(htaReport.getEconomicViability()) && !"null".equals(htaReport.getEconomicViability())) {
            if (CollUtil.isNotEmpty(economicViability)) {
                economicViability.add(htaReport.getEconomicViability());
            } else {
                economicViability = new JSONArray();
                economicViability.add(htaReport.getEconomicViability());
                source_json.put("economicViability", economicViability);
            }
        }

        JSONArray ethic = source_json.getJSONArray("ethic");
        if (StrUtil.isNotBlank(htaReport.getEthic()) && !"null".equals(htaReport.getEthic())) {
            if (CollUtil.isNotEmpty(ethic)) {
                ethic.add(htaReport.getEthic());
            } else {
                ethic = new JSONArray();
                ethic.add(htaReport.getEthic());
                source_json.put("ethic", ethic);
            }
        }

        JSONArray doctorAdvice = source_json.getJSONArray("doctorAdvice");
        if (StrUtil.isNotBlank(htaReport.getDoctorAdvice()) && !"null".equals(htaReport.getDoctorAdvice())) {
            if (CollUtil.isNotEmpty(doctorAdvice)) {
                doctorAdvice.add(htaReport.getDoctorAdvice());
            } else {
                doctorAdvice = new JSONArray();
                doctorAdvice.add(htaReport.getDoctorAdvice());
                source_json.put("doctorAdvice", doctorAdvice);
            }
        }

        JSONArray patientAdvice = source_json.getJSONArray("patientAdvice");
        if (StrUtil.isNotBlank(htaReport.getPatientAdvice()) && !"null".equals(htaReport.getPatientAdvice())) {
            if (CollUtil.isNotEmpty(patientAdvice)) {
                patientAdvice.add(htaReport.getPatientAdvice());
            } else {
                patientAdvice = new JSONArray();
                patientAdvice.add(htaReport.getPatientAdvice());
                source_json.put("patientAdvice", patientAdvice);
            }
        }

        JSONArray recommendedAdvice = source_json.getJSONArray("recommendedAdvice");
        if (StrUtil.isNotBlank(htaReport.getRecommendedAdvice()) && !"null".equals(htaReport.getRecommendedAdvice())) {
            if (CollUtil.isNotEmpty(recommendedAdvice)) {
                recommendedAdvice.add(htaReport.getRecommendedAdvice());
            } else {
                recommendedAdvice = new JSONArray();
                recommendedAdvice.add(htaReport.getRecommendedAdvice());
                source_json.put("recommendedAdvice", recommendedAdvice);
            }
        }

        JSONObject _json = new JSONObject();
        _json.put("title", htaReport.getTitle());
        _json.put("source", htaReport.getSource());
        _json.put("link", htaReport.getLink());
        _json.put("publishTime", publishTimes);
        JSONArray content = new JSONArray();
        JSONArray oriContent = new JSONArray();
        _json.put("content", content);
        _json.put("oriContent", oriContent);
        _json.put("transUrl", "");
        String pdfName = htaReport.getPdfName();
        if (StrUtil.isNotBlank(pdfName)) {
            if ("PBAC".equals(source)) {
                _json.put("transUrl", transHtaPdfUrl + "word_translated" + Constants.PAD_LEFT_SLASH + pdfName + ".docx");
                _json.put("url", htaPdfUrl + source + Constants.PAD_LEFT_SLASH + pdfName + ".docx");
            }
            if (Constants.TRANS_PDF_SOURCES.contains(source)) {
                _json.put("transUrl", transHtaPdfUrl + "hta_translated" + Constants.PAD_LEFT_SLASH + source + Constants.PAD_LEFT_SLASH + pdfName + "_zh.html");
                _json.put("url", htaPdfUrl + source + Constants.PAD_LEFT_SLASH + pdfName + ".pdf");
            }
        }
        List<String> pdfTagList = htaReport.getPdfTagList();
        List<List<FormatDataDTO>> wordCleanImagePdfDataGptVerList = htaReport.getWordCleanImagePdfDataGptVerList();
        List<String> cleanImagePdfDataGptVerList = htaReport.getCleanImagePdfDataGptVerList();
        int minSize = Math.min(pdfTagList.size(), wordCleanImagePdfDataGptVerList.size());
        minSize = Math.min(minSize, cleanImagePdfDataGptVerList.size());
        for (int i = 0; i < minSize; i++) {
            JSONObject tag_con = new JSONObject();
            JSONObject ori_tag_con = new JSONObject();
            String tag = pdfTagList.get(i);

            String oriCon = cleanImagePdfDataGptVerList.get(i);
            ori_tag_con.put(tag, oriCon);
            oriContent.add(ori_tag_con);

            List<FormatDataDTO> formatDataDTOS = wordCleanImagePdfDataGptVerList.get(i);
            tag_con.put(tag, formatDataDTOS);
            content.add(tag_con);
        }
        result_json.getJSONArray(source).add(_json);
    }

    private JSONObject filterHtaCon(JSONObject result, String type, String typeZh) {
        JSONObject resultObj = new JSONObject();
        List<String> drugAndWordEn = JSON.parseObject(JSON.toJSONString(result.getJSONArray("drugAndWordEn")), new TypeReference<List<String>>() {
        });
        String drugAndWordEnStr = "";
        if (CollUtil.isNotEmpty(drugAndWordEn)) {
            drugAndWordEnStr = String.join("与", drugAndWordEn);
        }

        String drugAndWordStr = "";
        List<String> diseaseAndWord = JSON.parseObject(JSON.toJSONString(result.getJSONArray("diseaseAndWord")), new TypeReference<List<String>>() {
        });
        if (CollUtil.isNotEmpty(diseaseAndWord)) {
            drugAndWordStr = String.join("与", diseaseAndWord);
        }
        // 想要个标题
        // 在澳大利亚 PBAC 网站上搜索“药品名称英文”，得到N篇有关的卫生技术评估报告，其中与“用户输入的研究疾病”相关的报告[xx]-[xx]中，有效性总结内容如下：
        //该来源中有效性总结结果。
        //在苏格兰SMC 网站上搜索“药品名称英文”，得到N篇有关的卫生技术评估报告，其中与“用户输入的研究疾病”相关的报告[xx]中，有效性总结内容如下：
        //该来源中有效性总结结果。

        // 筛选 hta 中想要的部分内容
        JSONObject digest_hta = result.getJSONObject("digestHta");
        if (Objects.nonNull(digest_hta)) {
            if (Objects.nonNull(digest_hta.getJSONObject("NICE")) && CollUtil.isNotEmpty(digest_hta.getJSONObject("NICE").getJSONArray(type))) {
                JSONObject innerObj = new JSONObject();
                int size = digest_hta.getJSONObject("NICE").getJSONArray(type).size();
//                String title = "在英国国家健康与卓越研究所 NICE 网站上搜索"+ drugAndWordEnStr +"，得到"+ size +"篇有关的卫生技术评估报告，其中与"+ drugAndWordStr +"相关的报告[xx]-[xx]中，有效性总结内容如下：";
                String title = "在英国国家健康与卓越研究所 NICE 网站上搜索" + drugAndWordEnStr + "，得到" + size + "篇有关的卫生技术评估报告，其中与" + drugAndWordStr + "相关的报告中，" + typeZh + "总结内容如下：";
                innerObj.put("title", title);
                JSONArray innerArr = new JSONArray();
                for (Object object : digest_hta.getJSONObject("NICE").getJSONArray(type)) {
                    innerArr.add(JSON.parseObject(JSON.toJSONString(object), String.class));
                }
                innerObj.put("table", innerArr);
                resultObj.put("NICE", innerObj);
            }
            if (Objects.nonNull(digest_hta.getJSONObject("SMC")) && CollUtil.isNotEmpty(digest_hta.getJSONObject("SMC").getJSONArray(type))) {
                JSONObject innerObj = new JSONObject();
                int size = digest_hta.getJSONObject("SMC").getJSONArray(type).size();
//                String title = "在苏格兰药物联盟 SMC 网站上搜索“药品名称英文”，得到"+ size +"篇有关的卫生技术评估报告，其中与“用户输入的研究疾病”相关的报告[xx]-[xx]中，有效性总结内容如下：";
                String title = "在苏格兰药物联盟 SMC 网站上搜索" + drugAndWordEnStr + "，得到" + size + "篇有关的卫生技术评估报告，其中与" + drugAndWordStr + "相关的报告中，" + typeZh + "总结内容如下：";
                innerObj.put("title", title);
                JSONArray innerArr = new JSONArray();
                for (Object object : digest_hta.getJSONObject("SMC").getJSONArray(type)) {
                    innerArr.add(JSON.parseObject(JSON.toJSONString(object), String.class));
                }
                innerObj.put("table", innerArr);
                resultObj.put("SMC", innerObj);
            }
            if (Objects.nonNull(digest_hta.getJSONObject("AWMSG")) && CollUtil.isNotEmpty(digest_hta.getJSONObject("AWMSG").getJSONArray(type))) {
                JSONObject innerObj = new JSONObject();
                int size = digest_hta.getJSONObject("AWMSG").getJSONArray(type).size();
//                String title = "在全威尔士医药经济小组 AWMSG 网站上搜索“药品名称英文”，得到"+ size +"篇有关的卫生技术评估报告，其中与“用户输入的研究疾病”相关的报告[xx]-[xx]中，有效性总结内容如下：";
                String title = "在全威尔士医药经济小组 AWMSG  网站上搜索" + drugAndWordEnStr + "，得到" + size + "篇有关的卫生技术评估报告，其中与" + drugAndWordStr + "相关的报告中，" + typeZh + "有效性总结内容如下：";
                innerObj.put("title", title);
                JSONArray innerArr = new JSONArray();
                for (Object object : digest_hta.getJSONObject("AWMSG").getJSONArray(type)) {
                    innerArr.add(JSON.parseObject(JSON.toJSONString(object), String.class));
                }
                innerObj.put("table", innerArr);
                resultObj.put("AWMSG", innerObj);
            }
            if (Objects.nonNull(digest_hta.getJSONObject("CADTH")) && CollUtil.isNotEmpty(digest_hta.getJSONObject("CADTH").getJSONArray(type))) {
                JSONObject innerObj = new JSONObject();
                int size = digest_hta.getJSONObject("CADTH").getJSONArray(type).size();
//                String title = "在加拿大药物和卫生技术局 CADTH 网站上搜索“药品名称英文”，得到"+ size +"篇有关的卫生技术评估报告，其中与“用户输入的研究疾病”相关的报告[xx]-[xx]中，有效性总结内容如下：";
                String title = "在加拿大药物和卫生技术局 CADTH 网站上搜索" + drugAndWordEnStr + "，得到" + size + "篇有关的卫生技术评估报告，其中与" + drugAndWordStr + "相关的报告中，" + typeZh + "总结内容如下：";
                innerObj.put("title", title);
                JSONArray innerArr = new JSONArray();
                for (Object object : digest_hta.getJSONObject("CADTH").getJSONArray(type)) {
                    innerArr.add(JSON.parseObject(JSON.toJSONString(object), String.class));
                }
                innerObj.put("table", innerArr);
                resultObj.put("CADTH", innerObj);
            }
//            if (Objects.nonNull(digest_hta.getJSONObject("IQWIG")) && CollUtil.isNotEmpty(digest_hta.getJSONObject("IQWIG").getJSONArray(type))) {
//                JSONObject innerObj = new JSONObject();
//                int size = digest_hta.getJSONObject("IQWIG").getJSONArray(type).size();
//                String title = "在德国医疗质量和效率研究所 IQWIG 网站上搜索“药品名称英文”，得到"+ size +"篇有关的卫生技术评估报告，其中与“用户输入的研究疾病”相关的报告[xx]-[xx]中，有效性总结内容如下：";
//                innerObj.put("title", title);
//                JSONArray innerArr = new JSONArray();
//                for (Object object : digest_hta.getJSONObject("IQWIG").getJSONArray(type)) {
//                    innerArr.add(JSON.parseObject(JSON.toJSONString(object), String.class));
//                }
//                innerObj.put("table", innerArr);
//                resultObj.put("IQWIG", innerObj);
//            }
            if (Objects.nonNull(digest_hta.getJSONObject("EUnetHTA")) && CollUtil.isNotEmpty(digest_hta.getJSONObject("EUnetHTA").getJSONArray(type))) {
                JSONObject innerObj = new JSONObject();
                int size = digest_hta.getJSONObject("EUnetHTA").getJSONArray(type).size();
//                String title = "在欧洲卫生技术评估网络 EUnetHTA 网站上搜索“药品名称英文”，得到"+ size +"篇有关的卫生技术评估报告，其中与“用户输入的研究疾病”相关的报告[xx]-[xx]中，有效性总结内容如下：";
                String title = "在欧洲卫生技术评估网络 EUnetHTA 网站上搜索" + drugAndWordEnStr + "，得到" + size + "篇有关的卫生技术评估报告，其中与" + drugAndWordStr + "相关的报告中，" + typeZh + "总结内容如下：";
                innerObj.put("title", title);
                JSONArray innerArr = new JSONArray();
                for (Object object : digest_hta.getJSONObject("EUnetHTA").getJSONArray(type)) {
                    innerArr.add(JSON.parseObject(JSON.toJSONString(object), String.class));
                }
                innerObj.put("table", innerArr);
                resultObj.put("EUnetHTA", innerObj);
            }
            if (Objects.nonNull(digest_hta.getJSONObject("INAHTA")) && CollUtil.isNotEmpty(digest_hta.getJSONObject("INAHTA").getJSONArray(type))) {
                JSONObject innerObj = new JSONObject();
                int size = digest_hta.getJSONObject("INAHTA").getJSONArray(type).size();
//                String title = "在国际卫生技术评估机构网络 INAHTA 网站上搜索“药品名称英文”，得到"+ size +"篇有关的卫生技术评估报告，其中与“用户输入的研究疾病”相关的报告[xx]-[xx]中，有效性总结内容如下：";
                String title = "在国际卫生技术评估机构网络 INAHTA 网站上搜索" + drugAndWordEnStr + "，得到" + size + "篇有关的卫生技术评估报告，其中与" + drugAndWordStr + "相关的报告中，" + typeZh + "总结内容如下：";
                innerObj.put("title", title);
                JSONArray innerArr = new JSONArray();
                for (Object object : digest_hta.getJSONObject("INAHTA").getJSONArray(type)) {
                    innerArr.add(JSON.parseObject(JSON.toJSONString(object), String.class));
                }
                innerObj.put("table", innerArr);
                resultObj.put("INAHTA", innerObj);
            }
            if (Objects.nonNull(digest_hta.getJSONObject("PBAC")) && CollUtil.isNotEmpty(digest_hta.getJSONObject("PBAC").getJSONArray(type))) {
                JSONObject innerObj = new JSONObject();
                int size = digest_hta.getJSONObject("PBAC").getJSONArray(type).size();
//                String title = "在药品福利咨询委员会 PBAC 网站上搜索“药品名称英文”，得到"+ size +"篇有关的卫生技术评估报告，其中与“用户输入的研究疾病”相关的报告[xx]-[xx]中，有效性总结内容如下：";
                String title = "在药品福利咨询委员会 PBAC 网站上搜索" + drugAndWordEnStr + "，得到" + size + "篇有关的卫生技术评估报告，其中与" + drugAndWordStr + "相关的报告中，" + typeZh + "总结内容如下：";
                innerObj.put("title", title);
                JSONArray innerArr = new JSONArray();
                for (Object object : digest_hta.getJSONObject("PBAC").getJSONArray(type)) {
                    innerArr.add(JSON.parseObject(JSON.toJSONString(object), String.class));
                }
                innerObj.put("table", innerArr);
                resultObj.put("PBAC", innerObj);
            }
        }

        if (Objects.isNull(resultObj.getJSONObject("NICE"))
                && Objects.isNull(resultObj.getJSONObject("SMC"))
                && Objects.isNull(resultObj.getJSONObject("AWMSG"))
                && Objects.isNull(resultObj.getJSONObject("CADTH"))
//                && Objects.nonNull(resultObj.getJSONObject("IQWIG"))
                && Objects.isNull(resultObj.getJSONObject("EUnetHTA"))
                && Objects.isNull(resultObj.getJSONObject("INAHTA"))
                && Objects.isNull(resultObj.getJSONObject("PBAC"))) {
            // 获取当前日期
            LocalDate now = LocalDate.now();
            // 减去7天得到一周前的日期
            LocalDate weekAgo = now.minusDays(7);
            // 创建一个日期格式器
            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy年 MM月dd日");
            // 格式化一周前的日期
            String formattedDate = weekAgo.format(formatter);

            String temp = result.getString("drugAndNotStr") + "治疗" + result.getString("diseaseAndNotStr");
            resultObj.put("hint", "本报告主要参考加拿大 CADTH、" +
                    "澳大利亚 PBAC、" +
                    "英国 NICE、" +
                    "英国苏格兰地区 SMC 、" +
                    "全威尔士医药策略小组 AWMSG、" +
                    "德国 IQWIG、" +
                    "欧洲 EUnetHTA" +
                    "以及国际HTA中心 INAHTA的卫生技术评估报告，" +
                    "以了解主要卫生技术评估组织的支付建议及目前相关临床研究结果。" +
                    "截止" + formattedDate + "，" +
                    "国内外主要 HTA 组织均无" + temp + "相关卫生技术评估报告。"
            );
        }
        return resultObj;
    }

    private void filterHtaReport(List<HtaReport> htaReports, Map<String, Map<String, String>> same_title_publishTime) {
        Set<String> titlesSet = new HashSet<>();
        if (CollUtil.isNotEmpty(htaReports)) {
            for (HtaReport htaReport : htaReports) {
                String title = htaReport.getTitle();
                String id = htaReport.getId();
                String publishTime = htaReport.getPublishTime();
                title = titleDispelSymbol(title);
                if (StrUtil.isNotBlank(title)) {
                    if (titlesSet.add(title)) { // 没有相同标题
                        Map<String, String> publishTime_id = new HashMap<>();
                        publishTime_id.put(publishTime, id);
                        same_title_publishTime.put(title, publishTime_id);
                    } else { // 有相同标题
                        same_title_publishTime.get(title).put(publishTime, id);
                    }
                }
            }
        }
    }

    private String titleDispelSymbol(String title) {
        String result = "";
        if (StrUtil.isNotBlank(title)) {
            result = title.replaceAll(Constants.REGEX_NOT_CHARACTER, "");
        }
        return result;
    }

    /**
     * 4.3 FAERS数据库分析
     */
    private void showDBAnalysis(JSONObject result, JSONObject data) {
        JSONObject showDBAnalysis = new JSONObject();
        data.put("showDBAnalysis", showDBAnalysis);

        //  信号分析
        signalAnalysis(result, showDBAnalysis);

        //  常见不良反应分析
        adverseAnalysis(result, showDBAnalysis);
    }

    private void signalAnalysis(JSONObject result, JSONObject showDBAnalysis) {
        JSONObject signalAnalysis = new JSONObject();
        showDBAnalysis.put("signalAnalysis", signalAnalysis);
        List<String> drugAndWord = JSON.parseObject(JSON.toJSONString(result.get("drugAndWord")), new TypeReference<List<String>>() {
        });
        
        JSONObject adverseReaction;
        if (Objects.nonNull(result.getJSONObject("adverseReaction"))) {
            adverseReaction = result.getJSONObject("adverseReaction");
        } else {
            adverseReaction = adverseService.info(result.getString("id"));
            result.put("adverseReaction", adverseReaction);
        }
        adverseReaction.remove("clinicalTrials");
        // 信号分析
        JSONObject signalAnalysis_ = adverseReaction.getJSONObject("adverse").getJSONObject("calculateTypicalSignals");
        if (Objects.nonNull(signalAnalysis_)) {
            JSONArray data = signalAnalysis_.getJSONArray("data");
            // 只要10条
            if (CollUtil.isNotEmpty(data) && data.size() > 10) {
                signalAnalysis_.put("data", JSON.parseObject(JSON.toJSONString(new ArrayList<>(data.subList(0, 10))), new TypeReference<List<JSONObject>>() {}));
            }
            signalAnalysis.put("signalAnalysis", signalAnalysis_);
            
            String total = "";
            String str_signalAnalysis = "暂无内容";
            if (Objects.nonNull(signalAnalysis_.getString("total"))) {
                total = signalAnalysis_.getString("total");
            }
            if (StrUtil.isBlank(total)) {
                total = "0";
            }
            if (CollUtil.isNotEmpty(drugAndWord)) {
                str_signalAnalysis = "截止至2024-12-31，FAERS数据库上报的所有不良反应数据中，以" + String.join("联合", drugAndWord) + "为首要怀疑药物的ADE报告" + total + "例。";
            } else {
                str_signalAnalysis = "";
            }
            signalAnalysis.put("signalAnalysis_str", str_signalAnalysis);
        } else {
            signalAnalysis.put("signalAnalysis_str", "截止至2024-12-31，FAERS数据库上报的所有不良反应数据中，以" + String.join("联合", drugAndWord) + "为首要怀疑药物的ADE报告0例。");
        }
    }

    private void adverseAnalysis(JSONObject result, JSONObject showDBAnalysis) {
        JSONObject adverseAnalysis = new JSONObject();
        showDBAnalysis.put("adverseAnalysis", adverseAnalysis);

        JSONObject adverseReaction;
        if (Objects.nonNull(result.getJSONObject("adverseReaction"))) {
            adverseReaction = result.getJSONObject("adverseReaction");
        } else {
            adverseReaction = adverseService.info(result.getString("id"));
        }

        JSONArray ptListArray = adverseReaction.getJSONObject("adverse").getJSONArray("ptList");
        if (CollUtil.isNotEmpty(ptListArray) && ptListArray.size() > 10) {
            List<JSONArray> filterList = JSON.parseObject(JSON.toJSONString(new ArrayList<>(ptListArray.subList(0, 10))), new TypeReference<List<JSONArray>>() {
            });
            adverseAnalysis.put("ptList", filterList);
            return;
        }
        adverseAnalysis.put("ptList", ptListArray);
    }

    /**
     * 4.2 政策分析
     */
    private void showPolicyAnalysis(JSONObject result, JSONObject data) {
        JSONObject showPolicyAnalysis = new JSONObject();
        data.put("showPolicyAnalysis", showPolicyAnalysis);

        // 药物境界快讯
        showPolicyAnalysis.put("policyAnalysis", "");
        // 药品不良反应信息通讯
        showPolicyAnalysis.put("report", "");

        JSONObject info = adverseService.info(result.getString("id"));
        if (Objects.nonNull(info)) {
            result.put("adverseReaction", info);
            // 药物境界快讯
            if (Objects.nonNull(info.getJSONObject("policy").getJSONObject("newsFlash"))) {
                JSONObject newsFlash = info.getJSONObject("policy").getJSONObject("newsFlash");
                showPolicyAnalysis.put("policyAnalysis", newsFlash);
            }
        }
    }

    /**
     * CDE评审报告情况
     */
    private void reviewReport(JSONObject result, JSONObject data) {
        JSONObject cde = new JSONObject();
        data.put("cde", cde);

        JSONArray cdeArrays = new JSONArray();
        cde.put("cdeArrays", cdeArrays);

        JSONArray drugAnd = result.getJSONArray("drugAnd");
        JSONArray diseaseAnd = result.getJSONArray("diseaseAnd");
        List<String> drugSynonyms = new ArrayList<>();
        List<String> diseaseSynonyms = new ArrayList<>();
        List<CdeData> cdeData;
        JSONArray cdeWordReports = new JSONArray();

        List<Criteria> disOrCriteriaList = new ArrayList<>();
        List<Criteria> disAndCriteriaList = new ArrayList<>();
        for (Object o : diseaseAnd) { // 病与病之间 and 关系，同病所有同义词 or 关系
            Disease disease = JSON.parseObject(JSON.toJSONString(o), Disease.class);
            diseaseSynonyms.add(disease.getWord());
            diseaseSynonyms.add(disease.getZhWord());
            diseaseSynonyms.add(disease.getEnWord());
            diseaseSynonyms.addAll(disease.getZhSynonym().stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
            diseaseSynonyms.addAll(disease.getEnSynonym().stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
            diseaseSynonyms.addAll(disease.getOtherSynonym().stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
            diseaseSynonyms.addAll(Arrays.stream(disease.getExpandSynonym().replaceAll(";", "；").split("；")).collect(Collectors.toList()));
            diseaseSynonyms = diseaseSynonyms.stream().filter(StrUtil::isNotBlank).distinct().collect(Collectors.toList());
            for (String disS : diseaseSynonyms) {
                disOrCriteriaList.add(Criteria.where("table_indication").regex(disS, "x")); // x 去掉空格
            }
            disAndCriteriaList.add(new Criteria().orOperator(disOrCriteriaList.toArray(new Criteria[0])));
        }

        // 必须药和病同时包含才需要
        if (CollUtil.isNotEmpty(drugAnd) && CollUtil.isNotEmpty(disAndCriteriaList)) {
            for (Object o : drugAnd) {
                List<Criteria> drugOrCriteriaList = new ArrayList<>();  // drgnamecn 需要包含输入药
                List<Criteria> ingredientOrCriteriaList = new ArrayList<>();  //  成分四列中需要匹配到药
                List<Criteria> tempCriteria = new ArrayList<>(); // 将病与药与成分进行 and

                Drug drug = JSON.parseObject(JSON.toJSONString(o), Drug.class);
                String drugName = drug.getZhWord();
                drugSynonyms.add(drug.getWord());
                drugSynonyms.add(drug.getZhWord());
                drugSynonyms.add(drug.getEnWord());
                drugSynonyms.addAll(drug.getZhSynonym().stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                drugSynonyms.addAll(drug.getEnSynonym().stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                drugSynonyms.addAll(drug.getOtherSynonym().stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                drugSynonyms.addAll(Arrays.stream(drug.getExpandSynonym().replaceAll(";", "；").split("；")).collect(Collectors.toList()));
                drugSynonyms = drugSynonyms.stream().filter(StrUtil::isNotBlank).distinct().collect(Collectors.toList());
                for (String drugS : drugSynonyms) {
                    if (drugS.startsWith("+") 
                            || drugS.endsWith("+") 
                            || drugS.startsWith("-") 
                            || drugS.endsWith("-")
                    || drugS.contains("+-")
                    || drugS.contains("-+")) {
                        continue;
                    }
                    drugOrCriteriaList.add(Criteria.where("drgnamecn").regex(drugS, "x"));
                    ingredientOrCriteriaList.add(Criteria.where("english_component").is(drugS));
                    ingredientOrCriteriaList.add(Criteria.where("english_component_synonyms").is(drugS));
                    ingredientOrCriteriaList.add(Criteria.where("chinese_component").is(drugS));
                    ingredientOrCriteriaList.add(Criteria.where("chinese_component_synonyms").is(drugS));
                }
                if (CollUtil.isNotEmpty(drugOrCriteriaList) || CollUtil.isNotEmpty(ingredientOrCriteriaList)) {
                    tempCriteria.add(new Criteria().orOperator(drugOrCriteriaList.toArray(new Criteria[0])));
                    tempCriteria.add(new Criteria().orOperator(ingredientOrCriteriaList.toArray(new Criteria[0])));
                    tempCriteria.addAll(disAndCriteriaList);
                    cdeData = ReleaseMongoUtil.mongo.find(new Query().addCriteria(new Criteria().andOperator(tempCriteria.toArray(new Criteria[0]))), CdeData.class);

                    // 组装数据
                    List<CdeData> needCdeData = new ArrayList<>();
                    if (CollUtil.isNotEmpty(cdeData)) {
                        // CDE报告纳入决策报告时，用发布时间再过滤一次   相同药物名称下的日期最新的
                        Map<String, List<CdeData>> filterAndGroupCdeData = cdeData.stream().sorted(Comparator.comparing(CdeData::getCreateddate).reversed()).collect(Collectors.groupingBy(CdeData::getDrgnamecn));
                        if (MapUtil.isNotEmpty(filterAndGroupCdeData)) {
                            for (Map.Entry<String, List<CdeData>> entry : filterAndGroupCdeData.entrySet()) {
                                List<CdeData> value = entry.getValue();
                                if (CollUtil.isNotEmpty(value)) {
                                    needCdeData.add(value.get(0));
                                }
                            }
                        }
                        for (CdeData cdeDatum : needCdeData) {
                            CdeWordReport cdeWordReport = new CdeWordReport();
                            cdeWordReport.setCdeId(cdeDatum.getId());

                            cdeWordReport.setQuestionId(result.getString("id"));
                            cdeWordReport.setDrugName(drugName);
                            cdeWordReport.setCreateTime(DateUtil.date());
                            cdeWordReports.add(cdeWordReport);

                            JSONObject temp = new JSONObject();
                            String acceptid = cdeDatum.getAcceptid();
                            String createdDate = cdeDatum.getCreateddate();
                            String drgnamecn = cdeDatum.getDrgnamecn();
                            temp.put("name", "药品名称：" + drgnamecn + " 受理号：" + acceptid + " 承办日期：" + createdDate);
                            // 适应症
                            temp.put("ftIndication", cdeDatum.getGptNewIndication());
                            // 有效性
                            temp.put("ftEffective", cdeDatum.getGptNewEffective());
                            // 安全性
                            temp.put("ftSafety", cdeDatum.getGptNewSafety());
                            // 获益与风险评估
//                        temp.put("ftConclusion", cdeDatum.getGptNewConclusion());
                            temp.put("ftConclusion", cdeDatum.getGptNewTecConclusion());
                            // 临床方面
                            temp.put("ftAspect", cdeDatum.getGptNewAspects());
                            // 技术结论
//                        temp.put("ftTecConclusion", cdeDatum.getGptNewTecConclusion());
                            temp.put("ftTecConclusion", cdeDatum.getGptNewConclusion());

                            temp.put("wordIndication", cdeDatum.getWordCleanIndication());
                            temp.put("wordEffective", cdeDatum.getWordCleanEffective());
                            temp.put("wordSafety", cdeDatum.getWordCleanSafety());
//                        temp.put("wordConclusion", cdeDatum.getWordCleanConclusion());
                            temp.put("wordConclusion", cdeDatum.getWordCleanTecConclusion());
                            temp.put("wordAspect", cdeDatum.getWordCleanAspects());
//                        temp.put("wordTecConclusion", cdeDatum.getWordCleanTecConclusion());
                            temp.put("wordTecConclusion", cdeDatum.getWordCleanConclusion());
                            cdeArrays.add(temp);
                        }

                        if (CollUtil.isNotEmpty(needCdeData)) {
                            List<String> ids = needCdeData.stream().map(CdeData::getId).collect(Collectors.toList());
                            OperateRequest operateRequest = new OperateRequest();
                            operateRequest.setId(result.getString("id"));
                            operateRequest.setIds(ids);
                            operateRequest.setOperate(1);
                            cdeService.operate(operateRequest, result.getLong("userId"));
                        }
                    }
                }
            }
        }

        if (CollUtil.isEmpty(cdeArrays)) {
            // 获取当前日期
            LocalDate now = LocalDate.now();
            // 减去7天得到一周前的日期
            LocalDate weekAgo = now.minusDays(7);
            // 创建一个日期格式器
            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy年 MM月dd日");
            // 格式化一周前的日期
            String formattedDate = weekAgo.format(formatter);

            String temp = result.getString("drugAndNotStr") + "治疗" + result.getString("diseaseAndNotStr");

            cde.put("hint", "根据国家药品监督管理局药品审评中心发布的上市药品信息技术评审报告，" +
                    "截止 " + formattedDate + "，药品评审中心无" + temp + "的相关信息。");
        }

        // 存储课题 id 和 cde 数据 id 的关系
        mongoTemplate.remove(new Query(Criteria.where("questionId").is(result.getString("id"))), CdeWordReport.class);
        mongoTemplate.insertAll(cdeWordReports);
    }

    private void drugCondition(JSONObject result, JSONObject data) {
        JSONArray otherSourceDrugInfo = new JSONArray();
        data.put("otherSourceDrugInfo", otherSourceDrugInfo);

        // 检索页面输入词 与 检索到的最全的说明书 用药助手 与 说明书信息合并 
        Map<String, String> drug_info_id = JSON.parseObject(JSON.toJSONString(result.get("drug_info_id")), new TypeReference<Map<String, String>>() {
        });
        if (CollUtil.isNotEmpty(drug_info_id)) {
            for (Map.Entry<String, String> entry : drug_info_id.entrySet()) {
                String redisKey = entry.getValue();
                JSONObject redisDrugInfoObj = JSON.parseObject(RedisUtils.getStr(redisKey));
    
                JSONObject innerObj = new JSONObject();
                String drugZh;

                if (Objects.nonNull(redisDrugInfoObj)) {
                    innerObj.put("drugName", redisDrugInfoObj.getString("name"));
                    drugZh = redisDrugInfoObj.getString("name");
                    // 贮藏条件
                    JSONArray jsonArray = redisDrugInfoObj.getJSONArray("storage");
                    innerObj.put("storage", "");
                    if (CollUtil.isNotEmpty(jsonArray)) {
                        innerObj.put("storage", jsonArray);
                    }
                } else {
                    drugZh = "";
                }

                // 采集
                List<Procurement> procurements = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("drugName").regex(drugZh, "ix")), Procurement.class);
                StringBuilder jicai = new StringBuilder();
                if (CollUtil.isNotEmpty(procurements)) {
                    procurements.forEach(procurement -> {
                        jicai.append(procurement.getDrugName()).append("-");
                        jicai.append(procurement.getPacking().replaceAll("\n", "")).append("-");
                        jicai.append(procurement.getManufactor().replaceAll("\n", "")).append("-");
                        jicai.append("(");
                        jicai.append(procurement.getSource());
                        jicai.append(")");
                        jicai.append("\n");
                    });
                } else {
                    jicai.append(drugZh).append("不属于国家/联盟集中采购药品。");
                }
                innerObj.put("drugCollection", jicai.toString());
                
                // 医保
                List<CdeCollect.MedicalInsurance> medicalInsurances;
                Query medicalQueryCom = new Query(new Criteria().orOperator(
                        Criteria.where("drugName").is(drugZh),
                        Criteria.where("name1").is(drugZh),
                        Criteria.where("name2").is(drugZh),
                        Criteria.where("name3").is(drugZh),
                        Criteria.where("name4").is(drugZh),
                        Criteria.where("name5").is(drugZh),
                        Criteria.where("name6").is(drugZh),
                        Criteria.where("name7").is(drugZh),
                        Criteria.where("name8").is(drugZh)
                    )
                );
                medicalInsurances = ReleaseMongoUtil.mongo.find(medicalQueryCom, CdeCollect.MedicalInsurance.class);

                if (CollUtil.isEmpty(medicalInsurances)) {
                    Query medicalQuery = new Query(new Criteria().orOperator(
                            Criteria.where("drugName").regex(drugZh, "ix"),
                            Criteria.where("name1").regex(drugZh, "ix"),
                            Criteria.where("name2").regex(drugZh, "ix"),
                            Criteria.where("name3").regex(drugZh, "ix"),
                            Criteria.where("name4").regex(drugZh, "ix"),
                            Criteria.where("name5").regex(drugZh, "ix"),
                            Criteria.where("name6").regex(drugZh, "ix"),
                            Criteria.where("name7").regex(drugZh, "ix"),
                            Criteria.where("name8").regex(drugZh, "ix")
                        )
                    );
                    medicalInsurances = ReleaseMongoUtil.mongo.find(medicalQuery, CdeCollect.MedicalInsurance.class);
                }
                
                StringBuilder yibao = new StringBuilder();
                if (CollUtil.isNotEmpty(medicalInsurances)) {
                    yibao.append("依据2024年版《国家基本医疗保险、工伤保险和生育保险药品目录》:").append("\n");
                    medicalInsurances.forEach(medicalInsurance -> {
                        yibao.append(medicalInsurance.getDrugName());
                        
                        String dosageForm = medicalInsurance.getDosageForm();
                        if (StrUtil.isNotBlank(dosageForm)) {
                            yibao.append(dosageForm);
                        }
                        
                        yibao.append("属于医保").append(medicalInsurance.getMedicalType()).append("类用药");
                        String payLimit = medicalInsurance.getPayLimit();
                        if (StrUtil.isNotBlank(payLimit)) {
                            if (!payLimit.endsWith("。")) payLimit += "。";
                            yibao.append("，").append(payLimit);
                        } else {
                            yibao.append("，无支付限制。");
                        }
                        yibao.append("\n");
                    });
                    if (yibao.toString().endsWith("\n")) {
                        yibao.deleteCharAt(yibao.length() - 1);
                    }
                } else {
                    yibao.append(drugZh).append("不属于国家医保药品目录范围内用药。");
                }
                innerObj.put("medicalInsurance", yibao.toString());


                // 基本药物
                JSONObject essentialMedicinesObj = new JSONObject();
                List<EssentialMedicines> essentialMedicinesList;
                Query essentialQueryCom = new Query(new Criteria().orOperator(
                        Criteria.where("variety_name").is(drugZh),
                        Criteria.where("name1").is(drugZh),
                        Criteria.where("name2").is(drugZh),
                        Criteria.where("name3").is(drugZh),
                        Criteria.where("name4").is(drugZh),
                        Criteria.where("name5").is(drugZh)
                )
                );
                essentialMedicinesList = ReleaseMongoUtil.mongo.find(essentialQueryCom, EssentialMedicines.class);

                if (CollUtil.isEmpty(essentialMedicinesList)) {
                    Query essentialQuery = new Query(new Criteria().orOperator(
                            Criteria.where("variety_name").regex(drugZh, "ix"),
                            Criteria.where("name1").regex(drugZh, "ix"),
                            Criteria.where("name2").regex(drugZh, "ix"),
                            Criteria.where("name3").regex(drugZh, "ix"),
                            Criteria.where("name4").regex(drugZh, "ix"),
                            Criteria.where("name5").regex(drugZh, "ix"))
                    );
                    essentialMedicinesList = ReleaseMongoUtil.mongo.find(essentialQuery, EssentialMedicines.class);
                }

                if (CollUtil.isNotEmpty(essentialMedicinesList)) {
                    EssentialMedicines essentialMedicines = essentialMedicinesList.get(0);
                    String title = "以下剂型与规格已纳入《国家基本药物目录(2018年版)》：" + "\n"
                            + essentialMedicines.getVarietyName() + ":";

                    essentialMedicinesObj.put("title", title);

                    String dosageFormAndSpecification = essentialMedicines.getDosageFormAndSpecification();
                    StringBuilder con = new StringBuilder();
                    if (StrUtil.isNotBlank(dosageFormAndSpecification)) {
                        con.append(dosageFormAndSpecification);
                    }
                    String note = essentialMedicines.getNote();
                    if (StrUtil.isNotBlank(note)) {
                        if (note.contains("△") && note.contains("注释")) {
                            con.append("\n").append("△");
                        } else if (note.contains("注释")) {
                            con.append(" ");
                        } else {
                            con.append("\n").append(note);
                        }
                    }
//                    con.replace(con.toString().length() - 1, con.toString().length(), "");
                    essentialMedicinesObj.put("con", con.toString());
                } else {
                    String title;
                    if (StrUtil.isNotBlank(drugZh)) {
                        title = drugZh + "并未纳入《国家基本药物目录(2018年版)》。";
                    } else {
                        title = "并未纳入《国家基本药物目录(2018年版)》。";
                    }
                    essentialMedicinesObj.put("title", title);
                }
                innerObj.put("essentialMedicines", essentialMedicinesObj);

                otherSourceDrugInfo.add(innerObj);
            }
        }
    }
    
    
    
    
    

    private void summarizeBrief(JSONObject result, JSONObject data) {
        JSONObject summarizeBrief = new JSONObject();
        data.put("summarizeBrief", summarizeBrief);
    }

    /**
     * 参考文献
     */
    private void bibliography(JSONObject result, JSONObject data) {
        JSONObject bibliography = (JSONObject) result.get("bibliography");
        data.put("bibliography", bibliography);

        JSONArray bibliographys3 = new JSONArray();
        if (Objects.nonNull(result.get("literaturesListMap"))) {
            // 之前所有关于文献内容的 名称与序号[count] 对应关系
            HashMap<String, Integer> literaturesListMap = JSON.parseObject(JSON.toJSONString(result.get("literaturesListMap")), new TypeReference<HashMap<String, Integer>>() {
            });

            // literaturesList 之前所有文献文内容
            JSONArray literaturesList = result.getJSONArray("literaturesList");
            List<Map.Entry<String, Integer>> literaturesListFilter = literaturesListMap.entrySet().stream().sorted(Map.Entry.comparingByValue()).collect(Collectors.toList());
            for (Map.Entry<String, Integer> entry : literaturesListFilter) {
                // 文献名称
                String key = entry.getKey();
                // 文献序号
                Integer value = entry.getValue();
                if (Objects.nonNull(literaturesList) && !literaturesList.isEmpty()) {
                    for (Object o : literaturesList) {
                        MongoLiterature mongoLiterature = JSON.parseObject(JSON.toJSONString(o), MongoLiterature.class);
                        String author = "";
                        if (CollUtil.isNotEmpty(mongoLiterature.getAuthor())) {
                            author = mongoLiterature.getAuthor().get(0);
                        }
                        String year = "";
                        if (StrUtil.isNotBlank(mongoLiterature.getYear())) {
                            year = mongoLiterature.getYear();
                        }

                        String title = "";
                        if (StrUtil.isNotBlank(mongoLiterature.getTitle())) {
                            title = mongoLiterature.getTitle();
                        }
                        
                        StringBuilder key_1 = new StringBuilder().append(author).append(" ").append(year).append(" ").append(title);
                        if (StrUtil.equals(key, key_1.toString())) {
                            //封装参考文献
                            this.refrenceBuilder(mongoLiterature, bibliographys3, "["+value+"]");
                            break;
                        }
                    }
                }
            }
        }
        bibliography.put("bibliographys3", bibliographys3);
    }

    private void refrenceBuilder(MongoLiterature mongoLiterature, JSONArray bibliographys, String value) {
        StringBuilder literatureBuilder = new StringBuilder();
        literatureBuilder.append(value);
        literatureBuilder.append(" ");
        literatureBuilder.append(StrUtil.isBlank(getThreeAuthorStr(mongoLiterature.getAuthor())) ? "" : getThreeAuthorStr(mongoLiterature.getAuthor()) + ".");
        literatureBuilder.append(StrUtil.isBlank(mongoLiterature.getTitle()) ? "" : HtmlUtil.cleanHtmlTag(mongoLiterature.getTitle()) + ".");
        literatureBuilder.append(StringUtils.isBlank(mongoLiterature.getJournal()) ? "" : (mongoLiterature.getJournal()));
        if (StrUtil.isNotBlank(mongoLiterature.getYear())) {
            literatureBuilder.append(",").append(mongoLiterature.getYear());
        }
        if (Objects.nonNull(mongoLiterature.getVolume()) && CollUtil.isNotEmpty(mongoLiterature.getVolume())) {
            literatureBuilder.append(",").append(mongoLiterature.getVolume().get(0));
            if (Objects.nonNull(mongoLiterature.getIssue()) && CollUtil.isNotEmpty(mongoLiterature.getIssue())) {
                literatureBuilder.append("(").append(mongoLiterature.getVolume().get(0)).append(")");
                if (Objects.nonNull(mongoLiterature.getPages()) && StrUtil.isNotBlank(mongoLiterature.getPages())) {
                    literatureBuilder.append(":").append(mongoLiterature.getPages()).append(".");
                } else {
                    literatureBuilder.append(".");
                }
            } else {
                if (Objects.nonNull(mongoLiterature.getPages()) && StrUtil.isNotBlank(mongoLiterature.getPages())) {
                    literatureBuilder.append(":").append(mongoLiterature.getPages()).append(".");
                } else {
                    literatureBuilder.append(".");
                }
            }
        } else {
            if (Objects.nonNull(mongoLiterature.getIssue()) && CollUtil.isNotEmpty(mongoLiterature.getIssue())) {
                literatureBuilder.append(",").append("(").append(mongoLiterature.getIssue().get(0)).append(")");
                if (Objects.nonNull(mongoLiterature.getPages()) && StrUtil.isNotBlank(mongoLiterature.getPages())) {
                    literatureBuilder.append(":").append(mongoLiterature.getPages()).append(".");
                } else {
                    literatureBuilder.append(".");
                }
            } else {
                if (Objects.nonNull(mongoLiterature.getPages()) && StrUtil.isNotBlank(mongoLiterature.getPages())) {
                    literatureBuilder.append(":").append(mongoLiterature.getPages()).append(".");
                } else {
                    literatureBuilder.append(".");
                }
            }
        }
        bibliographys.add(literatureBuilder.toString());
    }

    private String getThreeAuthorStr(List<String> author) {
        StringBuilder stringBuilder = new StringBuilder();
        if (CollUtil.isNotEmpty(author)) {
            for (int i = 0; i < author.size(); i++) {
                stringBuilder.append(",").append(author.get(i));
                if (i == 2) {
                    break;
                }
            }
        }
        return stringBuilder.length() == 0 ? "" : stringBuilder.substring(1, stringBuilder.length());
    }

    /**
     * 推荐等级判断
     */
    private void levelJudge(JSONObject result, boolean update, Condition condition) {
        JSONArray literaturesList = result.getJSONArray("literaturesList");
        // 推荐等级
        String recommendLevel = "--";
        // 证据等级
        String evidenceLevel = "--";
        int count_4 = 0;
        int count_7 = 0;

        // 找到一个最高推荐等级  数字越小等级越高
        Map<Integer, String> level = new HashMap<>();
        level.put(100, "--" + ";" + "--");

        if (Objects.nonNull(literaturesList) && !literaturesList.isEmpty()) {
            for (Object o : literaturesList) {
                MongoLiterature mongoLiterature = JSON.parseObject(JSON.toJSONString(o), MongoLiterature.class);
                if (StrUtil.isBlank(mongoLiterature.getQuality())) {
                    continue;
                }
                if (CollUtil.isEmpty(mongoLiterature.getLastNewType())) {
                    continue;
                }
                // 质量高 的 系统/Meta分析 ｜｜ 质量高的 Review
                String quality = mongoLiterature.getQuality();
                List<Integer> type = mongoLiterature.getLastNewType();
                if (("2".equals(quality) && CollUtil.contains(type, 3))
                        || ("2".equals(quality) && CollUtil.contains(type, 0))) {
                    evidenceLevel = "I a";
                    recommendLevel = "A";
                    level.put(1, "I a" + ";" + "A");
                    continue;
                }

                // 多项质量等级中的 RCT/nRCT
                if ("1".equals(quality) && CollUtil.contains(type, 4)) {
                    if (count_4 == 2) {
                        evidenceLevel = "I a";
                        recommendLevel = "A";
                        level.put(1, "I a" + ";" + "A");
                        count_4 = 0;
                        continue;
                    }
                    count_4++;
                }

                // 多项质量等级中的 临床试验
                if ("1".equals(quality) && CollUtil.contains(type, 7)) {
                    if (count_7 == 2) {
                        evidenceLevel = "I a";
                        recommendLevel = "A";
                        level.put(1, "I a" + ";" + "A");
                        count_7 = 0;
                        continue;
                    }
                    count_7++;
                }

                // 质量等级高的RCT/nRCT  ｜｜ 质量等级高的 临床试验
                if (("2".equals(quality) && CollUtil.contains(type, 4))
                        || ("2".equals(quality) && CollUtil.contains(type, 7))) {
                    evidenceLevel = "I b";
                    recommendLevel = "A";
                    level.put(2, "I b" + ";" + "A");
                    continue;
                }

                // 质量等级中的 Review
                if (("1".equals(quality) && CollUtil.contains(type, 0))) {
                    evidenceLevel = "II a";
                    recommendLevel = "B";
                    level.put(3, "II a" + ";" + "B");
                    continue;
                }

                // 质量低的RCT ｜｜ 质量低 的临床试验 ｜｜ 质量中或高的 Meta
                if (("0".equals(quality) && CollUtil.contains(type, 4))
                        || ("0".equals(quality) && CollUtil.contains(type, 7))
                        || ("1".equals(quality) && CollUtil.contains(type, 3))
                        || ("0".equals(quality) && CollUtil.contains(type, 3))) {
                    evidenceLevel = "II b";
                    recommendLevel = "B";
                    level.put(4, "II b" + ";" + "B");
                    continue;
                }

                // 质量高中的观察研究 ｜｜ 质量高中的病例
                if (("2".equals(quality) && CollUtil.contains(type, 5))
                        || ("1".equals(quality) && CollUtil.contains(type, 5))
                        || ("2".equals(quality) && CollUtil.contains(type, 1))
                        || ("1".equals(quality) && CollUtil.contains(type, 1))) {
                    evidenceLevel = "III a";
                    recommendLevel = "B";
                    level.put(5, "III a" + ";" + "B");
                    continue;
                }

                // 质量低的 观察行研究 ｜｜ 质量低的病例报告
                if (("0".equals(quality) && CollUtil.contains(type, 5))
                        || ("0".equals(quality) && CollUtil.contains(type, 1))) {
                    evidenceLevel = "IV";
                    recommendLevel = "C";
                    level.put(6, "IV" + ";" + "C");
                    continue;
                }

                // 基础研究
                if (CollUtil.contains(type, 9)) {
                    evidenceLevel = "V";
                    recommendLevel = "D";
                    level.put(7, "V" + ";" + "D");
                }
            }
        }

        if (MapUtil.isNotEmpty(level)) {
            List<Map.Entry<Integer, String>> levelSort = level.entrySet().stream().sorted(Map.Entry.comparingByKey()).collect(Collectors.toList());
            Map.Entry<Integer, String> entry = levelSort.get(0);
            String value = entry.getValue();
            String[] split = value.split(";");
            recommendLevel = split[1];
            evidenceLevel = split[0];
        }
        result.put("recommendLevel", recommendLevel);
        result.put("evidenceLevel", evidenceLevel);
        result.put("oldRecommendLevel", "");
        result.put("oldEvidenceLevel", "");
        if (update) {
            if (StrUtil.isNotBlank(recommendLevel)
                    && StrUtil.isNotBlank(evidenceLevel)) {
                // 是否有更新证据等级  true是 false 否
//                if (judgeLevel(recommendLevel, evidenceLevel, evidenceBasedReport)){
//                    Question question = mongoTemplate.findById(condition.getId(), Question.class);
//                    if (Objects.nonNull(question)) {
//                        question.setRenew(true);
//                        question.setRecommendLevel(recommendLevel);
//                        question.setEvidenceLevel(evidenceLevel);
//                        question.setOldRecommendLevel(evidenceBasedReport.getRecommendLevel());
//                        question.setOldEvidenceLevel(evidenceBasedReport.getEvidenceLevel());
//                        result.put("oldRecommendLevel", evidenceBasedReport.getRecommendLevel());
//                        result.put("oldEvidenceLevel", evidenceBasedReport.getEvidenceLevel());
//                        mongoTemplate.remove(new Query(Criteria.where("_id").is(condition.getId())), Question.class);
//                        mongoTemplate.save(question);
//                        return;
//                    }
//                }
            }
            Question question = mongoTemplate.findById(condition.getId(), Question.class);
            if (Objects.nonNull(question)) {
                question.setRenew(false);
                mongoTemplate.remove(new Query(Criteria.where("_id").is(condition.getId())), Question.class);
                mongoTemplate.save(question);
            }
        }
    }

//    private Boolean judgeLevel(String newRecommendLevel, String newEvidenceLevel, EvidenceBasedReport evidenceBasedReport) {
//        List<String> recommend = Arrays.asList("A", "B", "C", "D");
//        List<String> evidence = Arrays.asList("I a", "I b", "I c", "II a", "II b", "II c", "III a", "III b", "IV", "V");
//        if (StrUtil.isNotBlank(evidenceBasedReport.getRecommendLevel())
//                && StrUtil.isNotBlank(evidenceBasedReport.getEvidenceLevel())) {
//            String recommendLevel = evidenceBasedReport.getRecommendLevel();
//            String evidenceLevel = evidenceBasedReport.getEvidenceLevel();
//
//            int newRecIndex = recommend.indexOf(newRecommendLevel);
//            int oldRecIndex = recommend.indexOf(recommendLevel);
//
//            int newEviIndex = evidence.indexOf(newEvidenceLevel);
//            int oldEviIndex = evidence.indexOf(evidenceLevel);
//            // 推荐等级相等的情况
//            if (newRecIndex == oldRecIndex) return newEviIndex < oldEviIndex;
//            return newRecIndex < oldRecIndex;
//        }
//        return false;
//    }



    
   
    /**
     * 文新一言的进一步封装  只需要直接输入问题
     */
    private String wenChatResult(String query, int type) {
        String answer = "";
        if (StrUtil.isNotBlank(query)) {
            try {
                long begin = System.currentTimeMillis();
                String wenxinResult = wenChat(query, type);
                if (StrUtil.isNotBlank(wenxinResult)) {
                    answer = wenxinResult;
                    log.info("文新一言调用时间{},返回的内容是{}",System.currentTimeMillis()-begin, answer);
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
        return answer;
    }
    
    /**
     * 文新一言
     */
    private String wenChat(String msg, int type){
        log.info("query:{}",msg);
        try {
            ERNIE_Bot bot = new ERNIE_Bot();
            return bot.chat(msg, type);
            //return ernie_bot.chat(msg);
        }catch (Exception e){
            log.error(e.getMessage(),e);
            return "";
        }
    }
    
   
    public String executeGpt(String query, String name) {
        log.info("deepseek分析的问题是:{}", query);
        String result = youyideyi(query);
        log.info("----经过deepseek分析出来的结果是{}", result);
        return result;
    }

    /**
     * deepseek
     * @param msg 问题
     */
    private String youyideyi(String msg) {
        long ts = System.currentTimeMillis();
        GptParamDTO gptParamDTO = new GptParamDTO();
        gptParamDTO.setPrompt(HtmlUtil.cleanHtmlTag(msg));
        String response = null;
        try {
            response = getRequest(gptParamDTO);
        } catch (Exception e) {
            log.error(e.getMessage()+"*********deepseek调用失败*************prompt:"+msg, e);
        } 
        log.info("call deepseek cost time:{}", System.currentTimeMillis() - ts);
        if (StringUtils.isNotBlank(response)) {
            response = response.replaceAll("\\uFFFD", "");
            response = response.replaceAll("\n", "");
            return response.replaceAll("[\r\n]", "");
        }
        return "";
    }

    public String getRequest(GptParamDTO gptParamDTO) {
        return medicineFeign.generation(JSONObject.parseObject(JSONObject.toJSONString(gptParamDTO)));
    }

    private void getPaperAndGuideInclude(Condition condition, BaseCondition conditionLiteratureAlter, List<String> ids, Integer type) {
        // 进行文献精筛  中文文献
        PaperAndGuideIncludeDTO paperZhIncludeDTO = new PaperAndGuideIncludeDTO();
//        paperZhIncludeDTO.setScreenId(condition.getId());
        paperZhIncludeDTO.setScreenId(RandomUtil.randomString(10));
        paperZhIncludeDTO.setSearchQuery(defaultIncludeUtils.createSearchQuery(conditionLiteratureAlter));
        paperZhIncludeDTO.setQuery(QueryUtils.createPaperQuery(conditionLiteratureAlter, 1).toString());
        paperZhIncludeDTO.setTitleQuery(QueryUtils.createPaperQuery(conditionLiteratureAlter, 2).toString());
        paperZhIncludeDTO.setType(type);
        paperZhIncludeDTO.setLanguage(Arrays.asList("1", "2"));
        paperZhIncludeDTO.setStatus(1);
        paperZhIncludeDTO.setFormatType(4);
        ids.addAll(defaultIncludeUtils.paperAndGuideInclude(paperZhIncludeDTO));
    }
}


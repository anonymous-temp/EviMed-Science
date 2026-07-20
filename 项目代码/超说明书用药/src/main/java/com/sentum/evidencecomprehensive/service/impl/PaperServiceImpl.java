package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateTime;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.io.IoUtil;
import cn.hutool.core.lang.Snowflake;
import cn.hutool.core.map.MapUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.poi.excel.ExcelUtil;
import cn.hutool.poi.excel.ExcelWriter;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.itextpdf.text.DocumentException;
import com.itextpdf.text.Font;
import com.itextpdf.text.PageSize;
import com.itextpdf.text.Paragraph;
import com.itextpdf.text.pdf.BaseFont;
import com.itextpdf.text.pdf.PdfWriter;
import com.jcraft.jsch.*;
import com.mongodb.client.result.DeleteResult;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.constants.RedisKeyConstant;
import com.sentum.evidencecomprehensive.event.PictureAnalysisEvent;
import com.sentum.evidencecomprehensive.event.bo.PictureAnalysisBo;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.pojo.bo.QualityStatistics;
import com.sentum.evidencecomprehensive.pojo.bo.es.InstructionIndex;
import com.sentum.evidencecomprehensive.pojo.bo.es.PaperIndex;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.*;
import com.sentum.evidencecomprehensive.pojo.bo.upload.paper.*;
import com.sentum.evidencecomprehensive.pojo.dto.*;
import com.sentum.evidencecomprehensive.pojo.dto.entity.PaperInfo;
import com.sentum.evidencecomprehensive.pojo.dto.entity.PdfEdit;
import com.sentum.evidencecomprehensive.pojo.dto.entity.PdfEditResult;
import com.sentum.evidencecomprehensive.pojo.enums.PaperEditEconomyEnum;
import com.sentum.evidencecomprehensive.pojo.enums.PaperEditMetaEnum;
import com.sentum.evidencecomprehensive.pojo.enums.PaperEditRctEnum;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.JournalDivision;
import com.sentum.evidencecomprehensive.pojo.info.WordStatus;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.pojo.vo.ExcludeReasonVo;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;
import com.sentum.evidencecomprehensive.pojo.vo.PaperVo;
import com.sentum.evidencecomprehensive.pojo.vo.req.PaperInfoEditRequest;
import com.sentum.evidencecomprehensive.pojo.vo.req.PaperStandardRequest;
import com.sentum.evidencecomprehensive.pojo.vo.req.PaperUploadRequest;
import com.sentum.evidencecomprehensive.pojo.vo.req.PdfRequestRequest;
import com.sentum.evidencecomprehensive.pojo.vo.res.*;
import com.sentum.evidencecomprehensive.service.*;
import com.sentum.evidencecomprehensive.service.handler.IndexCombinationGenerator;
import com.sentum.evidencecomprehensive.service.handler.LiteratureDeduplicator;
import com.sentum.evidencecomprehensive.service.handler.MedicalTermFilter;
import com.sentum.evidencecomprehensive.service.handler.PaperSelector;
import com.sentum.evidencecomprehensive.utils.*;
import com.sentum.evidencecomprehensive.utils.operateyl.RedisUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.RetryUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.io.IOUtils;
import org.apache.commons.lang.StringUtils;
import org.dom4j.Document;
import org.dom4j.DocumentHelper;
import org.dom4j.Element;
import org.dom4j.io.OutputFormat;
import org.dom4j.io.XMLWriter;
import org.elasticsearch.common.lucene.search.function.CombineFunction;
import org.elasticsearch.common.lucene.search.function.FunctionScoreQuery;
import org.elasticsearch.index.query.*;
import org.elasticsearch.index.query.functionscore.FunctionScoreQueryBuilder;
import org.elasticsearch.index.query.functionscore.ScriptScoreFunctionBuilder;
import org.elasticsearch.script.Script;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.elasticsearch.search.aggregations.bucket.terms.TermsAggregationBuilder;
import org.elasticsearch.search.fetch.subphase.highlight.HighlightBuilder;
import org.elasticsearch.search.sort.SortBuilders;
import org.elasticsearch.search.sort.SortOrder;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.mapping.IndexCoordinates;
import org.springframework.data.elasticsearch.core.query.FetchSourceFilter;
import org.springframework.data.elasticsearch.core.query.HighlightQuery;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.elasticsearch.core.query.NativeSearchQueryBuilder;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import javax.servlet.ServletOutputStream;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static com.sentum.evidencecomprehensive.utils.HighLightUtils.highLight;

@Slf4j
@Service
public class PaperServiceImpl implements PaperService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private RetrievalService retrievalService;
    @Autowired
    private FineScreenFeign fineScreenFeign;
    @Autowired
    private PdfEditService pdfEditService;
    @Autowired
    private PdfEditResultService pdfEditResultService;
    @Autowired
    private ApplicationEventPublisher applicationEventPublisher;
    @Autowired
    private PaperInfoService paperInfoService;
    @Autowired
    private AiService aiService;
    
    @Value("${sftp.host}")
    private String sftpHost;
    @Value("${sftp.port}")
    private Integer sftpPort;
    @Value("${sftp.userName}")
    private String sftpUserName;
    @Value("${sftp.password}")
    private String sftpPassword;
    @Value("${sftp.path}")
    private String sftpPath;
    @Value("${sftp.filePath}")
    private String filePath;
    @Value("${sftp.host_alg}")
    private String sftpHost_alg;
    @Value("${sftp.port_alg}")
    private Integer sftpPort_alg;
    @Value("${sftp.userName_alg}")
    private String sftpUserName_alg;
    @Value("${sftp.password_alg}")
    private String sftpPassword_alg;
    @Value("${sftp.path_alg}")
    private String sftpPath_alg;


    private final ExecutorService executorService = Executors.newFixedThreadPool(10);

    @Override
    public JSONArray typeNumList(String id, String operateType, long userId) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw  new RuntimeException("检索id异常");
        }

        List<Integer> typeList = Arrays.asList(0, 1, 2, 14, 3, 4, 5, 6, 7, 8, 11, 9, 10);
        List<String> nameList = Arrays.asList("系统综述/Meta分析", "传统综述", "随机对照试验", "临床试验", "队列研究", "病例对照研究", "横断面研究", "病例系列", "病例报告", "专家意见和评价", "指南/共识", "动物实验", "体外实验");
        
        List<Integer> studyType = condition.getStudyType();
        List<String> selStudyType = new ArrayList<>();
        for (Integer type : studyType) {
            selStudyType.add(String.valueOf(type));
        }
        
        BoolQueryBuilder paperQuery = new BoolQueryBuilder();
        // 过滤没有title的文献
        paperQuery.must().add(QueryBuilders.existsQuery("title"));
        // 年份
        String literatureStartYear = condition.getLiteratureStartYear();
        String literatureEndYear = condition.getLiteratureEndYear();
        RangeQueryBuilder ysarRangeQueryBuilder = QueryBuilders.rangeQuery("year");
        if (StringUtils.isNotBlank(literatureStartYear)) {
            ysarRangeQueryBuilder.gte(literatureStartYear);
        }
        if (StringUtils.isNotBlank(literatureEndYear)) {
            ysarRangeQueryBuilder.lte(literatureEndYear);
        }
        paperQuery.must().add(ysarRangeQueryBuilder);

        // 研究类型
        BoolQueryBuilder studyTypeBool = new BoolQueryBuilder();
        if (CollectionUtils.isNotEmpty(studyType)) {
            for (Integer type : studyType) {
                if (type == 14) {
                    studyTypeBool.should().add(QueryBuilders.termQuery("type", 7));
                } else {
                    studyTypeBool.should().add(QueryBuilders.termQuery("lastNewType", type));
                }
            }
        } else {
            studyTypeBool.should().add(QueryBuilders.termsQuery("lastNewType", Constants.PAPER_LIST_LITERATURE_TYPE));
            studyTypeBool.should().add(QueryBuilders.matchQuery("type", 7));
        }
        paperQuery.must().add(studyTypeBool);

        boolean shouldData = false;
        // 期刊
        List<String> zhJournal = condition.getZhJournal();
        List<String> enJournal = condition.getEnJournal();
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        if (CollectionUtils.isNotEmpty(zhJournal) || CollectionUtils.isNotEmpty(enJournal)) {
            shouldData = true;
            if (zhJournal.size() == 5) {
                boolQueryBuilder.should().add(QueryBuilders.termQuery("language", "zh"));
            }
            if (CollectionUtils.isNotEmpty(zhJournal) && zhJournal.size() < 5) {
                for (String journal : zhJournal) {
                    BoolQueryBuilder zhBoolQueryBuilder = QueryBuilders.boolQuery();
                    zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "zh"));
                    switch (journal) {
                        case "北大核心":
                            journal = "Peking University";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "科技核心":
                            journal = "Technology";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "南大核心":
                            journal = "Nanjing University";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "CSCD":
                            journal = "CSCD";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "其他":
                            BoolQueryBuilder otherBool = QueryBuilders.boolQuery().mustNot(QueryBuilders.existsQuery("journalDivision"));
                            zhBoolQueryBuilder.must().add(otherBool);
                            break;
                        default:
                            break;
                    }
                    boolQueryBuilder.should().add(zhBoolQueryBuilder);
                }
            }

            if (enJournal.size() == 6) {
                boolQueryBuilder.should().add(QueryBuilders.termQuery("language", "en"));
            }
            if (CollectionUtils.isNotEmpty(enJournal) && enJournal.size() < 6) {
                if (enJournal.contains("其他")) {
                    BoolQueryBuilder enBoolQueryBuilder = QueryBuilders.boolQuery();
                    enBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "en"));
                    BoolQueryBuilder otherBool = QueryBuilders.boolQuery().mustNot(QueryBuilders.existsQuery("journalDivision"));
                    enBoolQueryBuilder.must().add(otherBool);
                    boolQueryBuilder.should().add(enBoolQueryBuilder);
                    enJournal.remove("其他");
                }
                if (CollectionUtils.isNotEmpty(enJournal)) {
                   
                    List<String> levelList = enJournal.stream().map(str -> {
                        int left = str.indexOf("Q");
                        int right = str.indexOf(")");
                        return str.substring(left + 1, right);
                    }).sorted().collect(Collectors.toList());

                    String highLevel = levelList.get(0);
                    for (String level : levelList) {
                        if ("5".equals(level)) {
                            level = "N/A";
                        }
                        BoolQueryBuilder enBoolQueryBuilder = QueryBuilders.boolQuery();
                        enBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "en"));
                        BoolQueryBuilder journalBoolQueryBuilder = new BoolQueryBuilder();
                        MatchPhraseQueryBuilder scie = QueryBuilders.matchPhraseQuery("journalDivision", "SCIE(Q" + level + ")");
                        MatchPhraseQueryBuilder esci = QueryBuilders.matchPhraseQuery("journalDivision", "ESCI(Q" + level + ")");
                        MatchPhraseQueryBuilder ssci = QueryBuilders.matchPhraseQuery("journalDivision", "SSCI(Q" + level + ")");
                        MatchPhraseQueryBuilder ahci = QueryBuilders.matchPhraseQuery("journalDivision", "AHCI(Q" + level + ")");
                        journalBoolQueryBuilder.should().add(scie);
                        journalBoolQueryBuilder.should().add(esci);
                        journalBoolQueryBuilder.should().add(ssci);
                        journalBoolQueryBuilder.should().add(ahci);
                        enBoolQueryBuilder.must().add(journalBoolQueryBuilder);
                        boolQueryBuilder.should().add(enBoolQueryBuilder);
                    }
//                    for (int i = Integer.parseInt(highLevel) - 1; i > 0; i--) {
//                        MatchPhraseQueryBuilder scie = QueryBuilders.matchPhraseQuery("journalDivision", "SCIE(Q" + i + ")");
//                        MatchPhraseQueryBuilder esci = QueryBuilders.matchPhraseQuery("journalDivision", "ESCI(Q" + i + ")");
//                        MatchPhraseQueryBuilder ssci = QueryBuilders.matchPhraseQuery("journalDivision", "SSCI(Q" + i + ")");
//                        MatchPhraseQueryBuilder ahci = QueryBuilders.matchPhraseQuery("journalDivision", "AHCI(Q" + i + ")");
//                        enBoolQueryBuilder.mustNot().add(scie);
//                        enBoolQueryBuilder.mustNot().add(esci);
//                        enBoolQueryBuilder.mustNot().add(ssci);
//                        enBoolQueryBuilder.mustNot().add(ahci);
//                    }
                   
                }
            }
            paperQuery.must().add(boolQueryBuilder);
        }

        NativeSearchQuery nativeSearchQuery;
        List<String> includeExcludeIds = new ArrayList<>();
        // 计算纳入排除的数量
        if ("1".equals(operateType) || "2".equals(operateType)) {
            if ("1".equals(operateType)) {
                //纳入文献
                List<PaperIncludeOrExclude> includeList = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);
                includeList.forEach(include -> includeExcludeIds.add(include.getPaperId()));
            }
            if ("2".equals(operateType)) {
                //排除文献
                List<PaperIncludeOrExclude> excludeList = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(2)), PaperIncludeOrExclude.class);
                excludeList.forEach(exclude -> includeExcludeIds.add(exclude.getPaperId()));
            }
            paperQuery.must().add(QueryBuilders.idsQuery().addIds(includeExcludeIds.toArray(new String[0])));
            nativeSearchQuery = new NativeSearchQuery(paperQuery);
        } else {
            BoolQueryBuilder paperQueryBool;
            String mode = condition.getMode();
            String zhEnExtension = condition.getZhEnExtension();
            String synonymExtension = condition.getSynonymExtension();
            if (StringUtils.isNotBlank(mode)) {
                // 高级检索
                paperQueryBool = useMode(mode, zhEnExtension, synonymExtension);
                paperQuery.must().add(paperQueryBool);
            } else {
//                QueryUtils.searchPaperByPI(condition.getDrugs().get(0).getWord(), "", paperQuery, retrievalService, elasticsearchRestTemplate);
                paperQuery.must().add(QueryUtils.createPaperQueryNew(condition, 1));
                paperQuery.filter().add(QueryBuilders.termsQuery("isIncomplete", "0", "2"));
            }
            nativeSearchQuery = new NativeSearchQuery(paperQuery);
        }
        
        nativeSearchQuery.setTrackTotalHits(true);
//        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("type").field("lastNewType").size(15);
        TermsAggregationBuilder aggregationBuilder2 = AggregationBuilders.terms("originalType").field("type").size(15);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        nativeSearchQuery.addAggregation(aggregationBuilder2);
        SearchHits<PaperIndex> search = null;
        long totalHits = 0L;
        Aggregations aggregations = null;
        if (shouldData) {
            try {
                search = RetryUtils.retry(
                        () -> elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class),
                        3,
                        1000,  // 每次重试间隔1秒
                        e -> true  // 对所有异常都重试，你也可以自定义条件，例如只对网络异常重试
                );
                totalHits = search.getTotalHits();
                aggregations = search.getAggregations();
            } catch (Exception e) {
                log.error("文献纳入查询错误: {}", e.getMessage(), e);
            }
        }
        
        JSONArray result = new JSONArray();                 
         
        Map<Integer, Long> numMap = new HashMap<>();
        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("type");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                int anInt = Integer.parseInt(bucket.getKey().toString());
                long docCount = bucket.getDocCount();
                numMap.put(anInt, docCount);
            }
            
            Aggregation aggregation2 = aggregations.get("originalType");
            List<? extends Terms.Bucket> buckets2 = ((ParsedTerms) aggregation2).getBuckets();
            for (Terms.Bucket bucket : buckets2) {
                int anInt = Integer.parseInt(bucket.getKey().toString());
                if (anInt == 7) {
                    long docCount = bucket.getDocCount();
                    numMap.put(14, docCount);
                    break;
                }
            }
        }

        for (int i = 0; i < typeList.size(); i++) {
            JSONObject inner = new JSONObject();
            
            long count = 0;
            
            Integer type = typeList.get(i);
            
            if (selStudyType.contains(String.valueOf(type))) {
                if (numMap.containsKey(type)) {
                    count = numMap.get(type);
                }
            }
            String name = nameList.get(i);
            inner.put("value", name + "(" + count + ")");
            inner.put("type", type);
            result.add(inner);
        }
        
        
        JSONObject inner = new JSONObject();
        inner.put("value", "总库(" + totalHits + ")");
        inner.put("type", 27);
        result.add(0, inner);
        return result;
    }
    
    @Override
    public PageVo<PaperVo> list(PaperSearchDto paperSearchDto, Long userId) {
        String id = paperSearchDto.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }
        
        BoolQueryBuilder paperQuery = new BoolQueryBuilder();
        
        // 对于残缺文献 需要有 title
        paperQuery.must().add(QueryBuilders.existsQuery("title"));
        
        //用户选择文献类型
        Integer studyType = paperSearchDto.getStudyType();
        if (studyType != 27) {
            if (studyType == 14) {
                paperQuery.must().add(QueryBuilders.termQuery("type", 7));
            } else {
                paperQuery.must().add(QueryBuilders.termQuery("lastNewType", studyType));
            }
        } else {
            BoolQueryBuilder studyTypeBool = new BoolQueryBuilder();

            List<Integer> defaultStudyType = condition.getStudyType();
            if (CollectionUtils.isNotEmpty(defaultStudyType)) {
                for (Integer type : defaultStudyType) {
                    if (type == 14) {
                        studyTypeBool.should().add(QueryBuilders.termQuery("type", 7));
                    } else {
                        studyTypeBool.should().add(QueryBuilders.termQuery("lastNewType", type));
                    }
                }
            }
            paperQuery.must().add(studyTypeBool);
        }
        
        // 语言类型
        Integer language = paperSearchDto.getLanguage();
        if (language != 0) {
            if (language == 1) {
                //中文
                paperQuery.must().add(QueryBuilders.termQuery("language", "zh"));
            }else {
                //英文
                paperQuery.must().add(QueryBuilders.termQuery("language", "en"));
            }
        }

        boolean shouldData = false;
        // 期刊
        List<String> zhJournal = condition.getZhJournal();
        List<String> enJournal = condition.getEnJournal();
        //期刊级别
        List<JournalDivision> journalLevel = paperSearchDto.getJournalLevel();
        String journalStr = journalLevel.stream().map(JournalDivision::getJournal).collect(Collectors.joining("、"));
        
        if (CollectionUtils.isNotEmpty(zhJournal) || CollectionUtils.isNotEmpty(enJournal)) {
            BoolQueryBuilder journalQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            if (zhJournal.size() == 5) {
                boolQueryBuilder.should().add(QueryBuilders.termQuery("language", "zh"));
                shouldData = true;
            }
            if (CollectionUtils.isNotEmpty(zhJournal) && zhJournal.size() < 5) {
                shouldData = true;

                for (String journal : zhJournal) {
                    BoolQueryBuilder zhBoolQueryBuilder = QueryBuilders.boolQuery();
                    zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "zh")); switch (journal) {
                        case "北大核心":
                            journal = "Peking University";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "科技核心":
                            journal = "Technology";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "南大核心":
                            journal = "Nanjing University";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "CSCD":
                            journal = "CSCD";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "其他":
                            BoolQueryBuilder otherBool = QueryBuilders.boolQuery().mustNot(QueryBuilders.existsQuery("journalDivision"));
                            zhBoolQueryBuilder.must().add(otherBool);
                            break;
                        default:
                            break;
                    }
                    boolQueryBuilder.should().add(zhBoolQueryBuilder);
                }
            }
            if (enJournal.size() == 6) {
                boolQueryBuilder.should().add(QueryBuilders.termQuery("language", "en"));
                shouldData = true;
            }
            if (CollectionUtils.isNotEmpty(enJournal) && enJournal.size() < 6) {
                shouldData = true;

                if (enJournal.contains("其他")) {
                    BoolQueryBuilder enBoolQueryBuilder = QueryBuilders.boolQuery();
                    enBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "en"));
                    BoolQueryBuilder otherBool = QueryBuilders.boolQuery().mustNot(QueryBuilders.existsQuery("journalDivision"));
                    enBoolQueryBuilder.must().add(otherBool);
                    boolQueryBuilder.should().add(enBoolQueryBuilder);
                    enJournal.remove("其他");
                }
                if (CollectionUtils.isNotEmpty(enJournal)) {

                    List<String> levelList = enJournal.stream().map(str -> {
                        int left = str.indexOf("Q");
                        int right = str.indexOf(")");
                        return str.substring(left + 1, right);
                    }).sorted().collect(Collectors.toList());

                    String highLevel = levelList.get(0);
                    for (String level : levelList) {
                        if ("5".equals(level)) {
                            level = "N/A";
                        }
                        BoolQueryBuilder enBoolQueryBuilder = QueryBuilders.boolQuery();
                        enBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "en"));
                        BoolQueryBuilder journalBoolQueryBuilder = new BoolQueryBuilder();
                        MatchPhraseQueryBuilder scie = QueryBuilders.matchPhraseQuery("journalDivision", "SCIE(Q" + level + ")");
                        MatchPhraseQueryBuilder esci = QueryBuilders.matchPhraseQuery("journalDivision", "ESCI(Q" + level + ")");
                        MatchPhraseQueryBuilder ssci = QueryBuilders.matchPhraseQuery("journalDivision", "SSCI(Q" + level + ")");
                        MatchPhraseQueryBuilder ahci = QueryBuilders.matchPhraseQuery("journalDivision", "AHCI(Q" + level + ")");
                        journalBoolQueryBuilder.should().add(scie);
                        journalBoolQueryBuilder.should().add(esci);
                        journalBoolQueryBuilder.should().add(ssci);
                        journalBoolQueryBuilder.should().add(ahci);
                        enBoolQueryBuilder.must().add(journalBoolQueryBuilder);
                        boolQueryBuilder.should().add(enBoolQueryBuilder);
                    }
                }
            }
            journalQueryBuilder.must(boolQueryBuilder);
            
            if (CollectionUtils.isNotEmpty(journalLevel) && !journalStr.contains("不限")) {
                boolean flag = true;
                if (flag) {
                    List<String> journalList = new ArrayList<>();
                    BoolQueryBuilder innerBoolQueryBuilder = QueryBuilders.boolQuery();
                    for (JournalDivision division : journalLevel) {
                        
                        String journal = division.getJournal();
                        List<String> divisionJournalDivision = division.getJournalDivision();
                        if (CollectionUtils.isNotEmpty(divisionJournalDivision) && divisionJournalDivision.size() < 5) {
                            for (String s : divisionJournalDivision) {
                                if (enJournal.contains(journal)) {
                                    MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("journalDivision", journal + " " + s);
                                    matchQueryBuilder.operator(Operator.AND);
                                    innerBoolQueryBuilder.should().add(matchQueryBuilder);
                                }
                            }
                            continue;
                        }

                        if (Constants.PAPER_ZH_TYPE.contains(journal)) {
//                            if (zhJournal.contains(journal)) {
                                BoolQueryBuilder zhBoolQueryBuilder = QueryBuilders.boolQuery();
                                zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "zh"));
                                switch (journal) {
                                    case "北大核心":
                                        journal = "Peking University";
                                        zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                                        break;
                                    case "科技核心":
                                        journal = "Technology";
                                        zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                                        break;
                                    case "南大核心":
                                        journal = "Nanjing University";
                                        zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                                        break;
                                    case "CSCD":
                                        journal = "CSCD";
                                        zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                                        break;
                                    case "其他":
                                        BoolQueryBuilder otherBool = QueryBuilders.boolQuery().mustNot(QueryBuilders.existsQuery("journalDivision"));
                                        zhBoolQueryBuilder.must().add(otherBool);
                                        break;
                                    default:
                                        break;
                                }
                                innerBoolQueryBuilder.should().add(zhBoolQueryBuilder);
                                shouldData = true;
//                            }
                        } else {
                            journalList.add(journal);
                        }
                    }

                    // 筛选出选中的英文期刊级别 
                    if (CollectionUtils.isNotEmpty(journalList)) {
                        for (String innerJournal : journalList) {
//                            if (enJournal.contains(innerJournal)) {
                                if ("其他".equals(innerJournal)) {
                                    BoolQueryBuilder enBoolQueryBuilder = QueryBuilders.boolQuery();
                                    enBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "en"));
                                    BoolQueryBuilder otherBool = QueryBuilders.boolQuery().mustNot(QueryBuilders.existsQuery("journalDivision"));
                                    enBoolQueryBuilder.must().add(otherBool);
                                    boolQueryBuilder.should().add(enBoolQueryBuilder);
                                    journalList.remove("其他");
                                    continue;
                                }                     
                                String innerLevel = innerJournal.substring(innerJournal.indexOf("Q") + 1, innerJournal.indexOf(")"));
                                BoolQueryBuilder enBoolQueryBuilder = QueryBuilders.boolQuery();
                                enBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "en"));
                                BoolQueryBuilder journalBoolQueryBuilder = new BoolQueryBuilder();
                                MatchPhraseQueryBuilder scie = QueryBuilders.matchPhraseQuery("journalDivision", "SCIE(Q" + innerLevel + ")");
                                MatchPhraseQueryBuilder esci = QueryBuilders.matchPhraseQuery("journalDivision", "ESCI(Q" + innerLevel + ")");
                                MatchPhraseQueryBuilder ssci = QueryBuilders.matchPhraseQuery("journalDivision", "SSCI(Q" + innerLevel + ")");
                                MatchPhraseQueryBuilder ahci = QueryBuilders.matchPhraseQuery("journalDivision", "AHCI(Q" + innerLevel + ")");
                                journalBoolQueryBuilder.should().add(scie);
                                journalBoolQueryBuilder.should().add(esci);
                                journalBoolQueryBuilder.should().add(ssci);
                                journalBoolQueryBuilder.should().add(ahci);
                                enBoolQueryBuilder.must().add(journalBoolQueryBuilder);
                                shouldData = true;
                                innerBoolQueryBuilder.should().add(enBoolQueryBuilder);

                            }          
//                        }
                    }
                    BoolQueryBuilder boolQueryBuilder1 = new BoolQueryBuilder();
                    boolQueryBuilder1.must().add(innerBoolQueryBuilder);
                    journalQueryBuilder.filter(boolQueryBuilder1);
                    paperQuery.must().add(journalQueryBuilder);
                }
            } else {
                paperQuery.must().add(journalQueryBuilder);
            }
//            else {
//               
//            }
//            paperQuery.must().add(journalQueryBuilder);
        }
        
        //文献质量
        List<Integer> quality = paperSearchDto.getQuality();
        if (!quality.contains(0) && quality.size() != 3) {
            BoolQueryBuilder qualityBool = QueryBuilders.boolQuery();
            List<String> ids1 = new ArrayList<>();
            List<PaperQuality> paperQualities1 = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("quality").is(0)), PaperQuality.class);
            paperQualities1.forEach(paperQuality -> ids1.add(paperQuality.getPaperId()));
            List<String> ids2 = new ArrayList<>();
            List<PaperQuality> paperQualities2 = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("quality").is(1)), PaperQuality.class);
            paperQualities2.forEach(paperQuality -> ids2.add(paperQuality.getPaperId()));
            List<String> ids3 = new ArrayList<>();
            List<PaperQuality> paperQualities3 = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("quality").is(2)), PaperQuality.class);
            paperQualities3.forEach(paperQuality -> ids3.add(paperQuality.getPaperId()));
            List<Integer> realQuality = new ArrayList<>();
            for (Integer integer : quality) {
                switch (integer) {
                    case 1:
                        //低
                        realQuality.add(0);
                        break;
                    case 2:
                        //中
                        realQuality.add(1);
                        break;
                    case 3:
                        //高
                        realQuality.add(2);
                        break;
                    default:
                        break;
                }
            }
            if (CollectionUtils.isNotEmpty(ids1) || CollectionUtils.isNotEmpty(ids2) || CollectionUtils.isNotEmpty(ids3)) {
                List<String> inIds = new ArrayList<>();
                List<String> outIds = new ArrayList<>();
                if (quality.size() == 1) {
                    //勾选单个质量
                    Integer anInt = quality.get(0);
                    if (anInt == 1) {
                        qualityBool(ids1, ids2, ids3, inIds, outIds, 1);
                    } else if (anInt == 2) {
                        qualityBool(ids2, ids1, ids3, inIds, outIds, 1);
                    } else {
                        qualityBool(ids3, ids1, ids2, inIds, outIds, 1);
                    }
                } else {
                    //勾选2个质量
                    if (!quality.contains(1)) {
                        qualityBool(ids2, ids3, ids1, inIds, outIds, 2);
                    } else if (!quality.contains(2)) {
                        qualityBool(ids1, ids3, ids2, inIds, outIds, 2);
                    } else {
                        qualityBool(ids1, ids2, ids3, inIds, outIds, 2);
                    }
                }
                if (CollectionUtils.isNotEmpty(inIds)) {
                    qualityBool.should().add(QueryBuilders.idsQuery().addIds(inIds.toArray(new String[0])));
                }
                if (CollectionUtils.isNotEmpty(outIds)) {
                    qualityBool.mustNot().add(QueryBuilders.idsQuery().addIds(outIds.toArray(new String[0])));
                }
            }
            qualityBool.should().add(QueryBuilders.termsQuery("quality", realQuality));
            paperQuery.must().add(qualityBool);
        }

        //发表年份
        String startSearchYear;
        String endSearchYear;
        String literatureStartYear = condition.getLiteratureStartYear();
        String literatureEndYear = condition.getLiteratureEndYear();
        Integer startYear = paperSearchDto.getStartYear();
        if (startYear != null) {
            if (startYear >= Integer.parseInt(literatureStartYear) && startYear <= Integer.parseInt(literatureEndYear)) {
                startSearchYear = startYear.toString();
            } else {
                startSearchYear = literatureStartYear;
            }
        } else {
            startSearchYear = literatureStartYear;
        }
        Integer endYear = paperSearchDto.getEndYear();
        if (endYear != null) {
            if (endYear >= Integer.parseInt(literatureStartYear) && endYear <= Integer.parseInt(literatureEndYear)) {
                endSearchYear = endYear.toString();
            } else {
                endSearchYear = literatureEndYear;
            }
        }else {
            endSearchYear = literatureEndYear;
        }
        
        if (startYear != null && startYear > Integer.parseInt(literatureEndYear)) {
            startSearchYear = "-1";
            endSearchYear = "-1";
        }
        if (endYear != null && endYear < Integer.parseInt(literatureStartYear)) {
            startSearchYear = "-1";
            endSearchYear = "-1";
        }
        paperQuery.must().add(QueryBuilders.rangeQuery("year").gte(startSearchYear));
        paperQuery.must().add(QueryBuilders.rangeQuery("year").lte(endSearchYear));

        //二次搜索条件
        String search = paperSearchDto.getSearch();
        if (StringUtils.isNotBlank(search)) {
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(search, "title", "summary", "author", "year", "journal");
            multiMatchQueryBuilder.operator(Operator.AND);
            //使用精准查询
            multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            multiMatchQueryBuilder.field("title", 24F);
            paperQuery.must().add(multiMatchQueryBuilder);
        }
        
        //排序-分页
        Integer sortType = paperSearchDto.getSortType();
        Integer sortDirection = paperSearchDto.getSortDirection();
        PageRequest pageRequest = PageRequest.of(paperSearchDto.getPageNum() - 1, paperSearchDto.getPageSize());
        if (sortType == 1) {
            //影响因子
            Sort.Direction direction = Sort.Direction.ASC;
            if (sortDirection == 0) {
                direction = Sort.Direction.DESC;
            }
            pageRequest = PageRequest.of(paperSearchDto.getPageNum() - 1, paperSearchDto.getPageSize(), Sort.by(direction, "jcr"));
        } else if (sortType == 2) {
            //年份
            Sort.Direction direction = Sort.Direction.ASC;
            if (sortDirection == 0) {
                direction = Sort.Direction.DESC;
            }
            pageRequest = PageRequest.of(paperSearchDto.getPageNum() - 1, paperSearchDto.getPageSize(), Sort.by(direction, "year"));
        }

        //用户选择文献类型
        Integer operateType = paperSearchDto.getOperateType();
        if (operateType == 1) {
            //纳入文献
            List<PaperIncludeOrExclude> includeList = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);
            List<String> ids = new ArrayList<>();
            includeList.forEach(include -> ids.add(include.getPaperId()));
            paperQuery.must().add(QueryUtils.createPaperQueryNew(condition, 1));
            paperQuery.filter().add(QueryBuilders.idsQuery().addIds(ids.toArray(new String[0])));
        } else if (operateType == 2) {
            //排除文献
            List<PaperIncludeOrExclude> excludeList = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(2)), PaperIncludeOrExclude.class);
            List<String> ids = new ArrayList<>();
            excludeList.forEach(exclude -> ids.add(exclude.getPaperId()));
            paperQuery.must().add(QueryBuilders.idsQuery().addIds(ids.toArray(new String[0])));
        } else {
            BoolQueryBuilder paperQueryBool;
            String mode = condition.getMode();
            String zhEnExtension = condition.getZhEnExtension();
            String synonymExtension = condition.getSynonymExtension();
            if (StringUtils.isNotBlank(mode)) {
                // 高级检索
                paperQueryBool = useMode(mode, zhEnExtension, synonymExtension);
                paperQuery.must().add(paperQueryBool);
            } else {
                paperQuery.must().add(QueryUtils.createPaperQueryNew(condition, 1));
                paperQuery.filter().add(QueryBuilders.termsQuery("isIncomplete", "0", "2"));
            }
        }

        List<String> drugSynonym = handleDrugToSynonym(condition.getDrugs());
        List<String> diseaseSynonym = handleDiseaseToSynonym(condition.getDiseases());

        List<String> handledDrugToSynonymForSearch = handleDrugToSynonymForSearch(condition.getDrugs());
        List<String> handleDiseaseToSynonymForSearch = handleDiseaseToSynonymForSearch(condition.getDiseases());

        NativeSearchQuery nativeSearchQuery;
        //开始排序
        if (sortType == 0) {
            String scriptStr = "def baseScore = Math.log1p(_score + 1) * 0.5; return baseScore;";
            Script script = new Script(scriptStr);
            ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);

            String incompleteScriptStr = "if(doc['isIncomplete'].size() > 0 && doc['isIncomplete'].value == 1) { " +
                    "  return 0.1; " +
                    "} else { " +
                    "  return 1.0; " +
                    "}";
            Script incompleteScript = new Script(incompleteScriptStr);
            ScriptScoreFunctionBuilder incompleteScriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(incompleteScript);
            
            // 添加语言降权的脚本函数
            String languageScriptStr = "if(doc['language'].size() > 0 && doc['language'].value == 'zh') { " +
                    "  return 0.7; " +  // 中文文献乘以0.7的权重
                    "} else { " +
                    "  return 1.0; " +   // 英文文献保持原权重
                    "}";
            Script languageScript = new Script(languageScriptStr);
            ScriptScoreFunctionBuilder languageScriptFunction = new ScriptScoreFunctionBuilder(languageScript);

            String lastNewTypeScriptStr = "if(doc['lastNewType'].size() > 0) { " +
                    "  for(int i = 0; i < doc['lastNewType'].length; i++) { " +
                    "    def value = doc['lastNewType'][i]; " +
                    "    int intValue = Integer.parseInt(value.toString()); " +
                    "    if(intValue == 0 || intValue == 2 || intValue == 3) { " +
                    "      return 2; " +
                    "    } " +
                    "  } " +
                    "  return 1; " +  // 如果循环完成都没有匹配的值
                    "} else { " +
                    "  return 1; " +  // 统一返回类型
                    "}";
            Script lastNewTypeScript = new Script(lastNewTypeScriptStr);
            ScriptScoreFunctionBuilder lastNewTypeScriptFunction = new ScriptScoreFunctionBuilder(lastNewTypeScript);

            FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[4];
            filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
            filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(incompleteScriptScoreFunctionBuilder);
//            filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
            filterFunctionBuilders[2] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(languageScriptFunction);
            filterFunctionBuilders[3] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(lastNewTypeScriptFunction);

            FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(paperQuery, filterFunctionBuilders);
//            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.MULTIPLY);
            functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);

            // 创建 NativeSearchQuery
            nativeSearchQuery = new NativeSearchQueryBuilder()
                    .withQuery(functionScoreQueryBuilder)
                    .withSort(SortBuilders.scoreSort().order(SortOrder.DESC))
                    .withSourceFilter(new FetchSourceFilter(new String[]{}, new String[0]))
                    .build();
        } else {
            nativeSearchQuery = new NativeSearchQueryBuilder()
                    .withQuery(paperQuery)
                    .build();
        }
        nativeSearchQuery.setPageable(pageRequest);
        
        //高亮 - 构建简化的高亮查询，避免复杂查询导致过度高亮
        String preTag = "<b>";
        String postTag = "</b>";
        HighlightBuilder highlightBuilder = new HighlightBuilder();
        
        // 为高亮构建简化的查询
        BoolQueryBuilder simpleHighlightQuery = QueryBuilders.boolQuery();
        for (String keyword : drugSynonym) {
            if (StringUtils.isNotBlank(keyword)) {
                simpleHighlightQuery.should(QueryBuilders.multiMatchQuery(keyword, "title", "summary").type(MultiMatchQueryBuilder.Type.PHRASE));
            }
        }
        for (String keyword : diseaseSynonym) {
            if (StringUtils.isNotBlank(keyword)) {
                simpleHighlightQuery.should(QueryBuilders.multiMatchQuery(keyword, "title", "summary").type(MultiMatchQueryBuilder.Type.PHRASE));
            }
        }
        
        HighlightBuilder.Field titleField = new HighlightBuilder.Field("title");
        titleField.highlightQuery(simpleHighlightQuery);
        HighlightBuilder.Field summaryField = new HighlightBuilder.Field("summary");
        summaryField.highlightQuery(simpleHighlightQuery);
        
        highlightBuilder.field(titleField);
        highlightBuilder.field(summaryField);
        highlightBuilder.preTags(preTag);
        highlightBuilder.postTags(postTag);
        highlightBuilder.fragmentSize(1024);
        highlightBuilder.numOfFragments(0);
        highlightBuilder.requireFieldMatch(false);
        nativeSearchQuery.setHighlightQuery(new HighlightQuery(highlightBuilder));
        nativeSearchQuery.setTrackTotalHits(true);

        List<PaperVo> list = new ArrayList<>();
        List<String> stopWord = ObjectToListUtil.objToList(RedisUtil.redis.opsForValue().get("jieba_word"), String.class);
        
        long totalHits = 0L;
        SearchHits<PaperIndex> searchHits = null;
        if (shouldData) {
            //开始查询
            searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class);
            totalHits = searchHits.getTotalHits();
        }
        
        // 如果首页8大类型没有勾选对应类型，list 查询是不允许有数据的
        if (!condition.getStudyType().contains(studyType) && studyType != 27) {
            searchHits = null;
        }
        if (Objects.nonNull(searchHits)) {
            list.addAll(processPapers(searchHits, id, userId, stopWord, condition, search, executorService));
        }
        int pages = (int) (totalHits % paperSearchDto.getPageSize() == 0 ? totalHits / paperSearchDto.getPageSize() : totalHits / paperSearchDto.getPageSize() + 1);
        PageVo<PaperVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(paperSearchDto.getPageSize());
        page.setPageNum(paperSearchDto.getPageNum());
        return page;
    }

    @Override
    public void includeLatest(String id, Long userId) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.nonNull(condition)) {

            List<MongoLiterature> mongoLiteratures = new ArrayList<>();
            List<String> needIncludeIds;

            try {
                // 调用修改后的搜索方法，传入累积结果列表
                searchWithSynonymCombinationAndFilter(condition, mongoLiteratures);

                needIncludeIds = mongoLiteratures.stream().map(MongoLiterature::getId).collect(Collectors.toList());

                PaperOperateDto paperOperateDto = new PaperOperateDto(id, new ArrayList<>(needIncludeIds), 1);
                operate(paperOperateDto, userId);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
    }
    public void searchWithSynonymCombinationAndFilter(Condition condition,
                                                      List<MongoLiterature> mongoLiteratures) {
        int TOTAL_QUOTA = 30;
        int currentRound = 0;
        List<Disease> diseases = condition.getDiseases();
        Set<String> ids = new HashSet<>();

        // 获取每个疾病中 synonymMap 的 key 数量（排序后）
        List<Integer> lengths = diseases.stream().filter(o -> o.getStatus() == 1)
                .map(d -> {
                    List<String> keys = new ArrayList<>(d.getSynonymMap().keySet());
                    keys.sort((a, b) -> Integer.compare(b.length(), a.length()));
                    return keys.size();
                })
                .collect(Collectors.toList());

        IndexCombinationGenerator generator = new IndexCombinationGenerator(lengths);

        // 用于跟踪各类型已选择的数量
        Map<Integer, Integer> globalTypeSelectedCount = new HashMap<>();

        List<PaperIndex> paperIndices = new ArrayList<>();
        List<PaperIndex> alternativeOne = new ArrayList<>();
        List<PaperIndex> alternativeTwo = new ArrayList<>();
        List<PaperIndex> alternativeThree = new ArrayList<>();
        List<PaperIndex> alternativeFour = new ArrayList<>();
        
        while (generator.hasNext() && mongoLiteratures.size() < TOTAL_QUOTA) {
            List<Integer> indices = generator.next();
            currentRound++;

            // 执行单次搜索
            List<SearchHit<PaperIndex>> searchHits = executeSearchWithIndices(condition, indices, alternativeOne, alternativeTwo, alternativeThree, alternativeFour);
           
            if (CollectionUtils.isNotEmpty(searchHits)) {

                searchHits.forEach(hit -> {
                    PaperIndex paperIndex = hit.getContent();
                    paperIndices.add(paperIndex);
                });

//                // 年份过滤和语言分组
//                Map<String, List<PaperIndex>> groupByLanguage = filterByYearAndGroupByLanguage(searchHits, condition);
//
//                if (MapUtils.isNotEmpty(groupByLanguage)) {
//
//                    int totalSelectedCount = getTotalSelectedCountWithDetails(globalTypeSelectedCount);
//                    // 计算本轮可用配额
//                    int remainingQuota = TOTAL_QUOTA - totalSelectedCount;
//                    log.info("本轮可用配额: {}", remainingQuota);
//                    
//                    // 调用修改后的筛选方法
//                    filterPaperByLanguageWithQuota(groupByLanguage, mongoLiteratures, fineScreenFeign,
//                            remainingQuota, globalTypeSelectedCount, currentRound, ids);
////
//                    log.info("第{}轮搜索完成，当前总数/第{}轮得到数量: {}/{}",
//                            currentRound, currentRound, mongoLiteratures.size(), TOTAL_QUOTA);
//                }
            }
        }

        if (CollectionUtils.isNotEmpty(paperIndices)) {
            // 执行筛选
            List<PaperIndex> selected = PaperSelector.selectPapers(paperIndices);

            if (selected.size() < 6) {
                if (!alternativeOne.isEmpty()) selected.addAll(PaperSelector.selectPapers(alternativeOne));
            }
            if (selected.size() < 6) {
                if (!alternativeTwo.isEmpty()) selected.addAll(PaperSelector.selectPapers(alternativeTwo));
            }
            if (selected.size() < 6) {
                if (!alternativeThree.isEmpty()) selected.addAll(PaperSelector.selectPapers(alternativeThree));
            }
            if (selected.size() < 6) {
                if (!alternativeFour.isEmpty()) selected.addAll(PaperSelector.selectPapers(alternativeFour));
            }

            mongoLiteratures.addAll(LiteratureDeduplicator.deduplicateLiteratures(selected, fineScreenFeign));
        }
    }


    @Override
    public Boolean operate(PaperOperateDto paperOperateDto, Long userId) {
        String conditionId = paperOperateDto.getId();
        List<String> ids = paperOperateDto.getIds();
        //操作的命令，1-纳入；2-取消纳入；3-排除；4-取消排除；5-收藏；6-取消收藏
        Integer operate = paperOperateDto.getOperate();
        boolean flag = false;
        switch (operate) {
            case 2:
            case 4:
                DeleteResult deleteInclude = mongoTemplate.remove(new Query(Criteria.where("paperId").in(ids).and("userId").is(userId).and("conditionId").is(conditionId)), PaperIncludeOrExclude.class);
                flag = deleteInclude.getDeletedCount() > 0;
                break;
            case 6:
                DeleteResult deleteCollet = mongoTemplate.remove(new Query(Criteria.where("paperId").in(ids).and("userId").is(userId).and("conditionId").is(conditionId)), PaperCollect.class);
                flag = deleteCollet.getDeletedCount() > 0;
                break;
            case 1:
                boolean includeFlag1 = false;
                boolean includeFlag2 = false;
                List<PaperIncludeOrExclude> includeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("paperId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    PaperIncludeOrExclude include = mongoTemplate.findOne(query, PaperIncludeOrExclude.class);
                    if (include != null) {
                        Integer status = include.getStatus();
                        if (status == 2) {
                            //修改为纳入
                            Update update = new Update();
                            update.set("status", 1);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, PaperIncludeOrExclude.class);
                            includeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    }else {
                        includeList.add(new PaperIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 1, userId, System.currentTimeMillis()));
                    }
                }
                if (!includeList.isEmpty()) {
                    Collection<PaperIncludeOrExclude> insert = mongoTemplate.insert(includeList, PaperIncludeOrExclude.class);
                    if (CollectionUtils.isNotEmpty(insert)) {
                        includeFlag2 = true;
                    }
                }
                if (includeFlag1 || includeFlag2) {
                    flag = true;
                }
                break;
            case 3:
                boolean excludeFlag1 = false;
                boolean excludeFlag2 = false;
                List<PaperIncludeOrExclude> excludeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("paperId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    PaperIncludeOrExclude exclude = mongoTemplate.findOne(query, PaperIncludeOrExclude.class);
                    if (exclude != null) {
                        Integer status = exclude.getStatus();
                        if (status == 1) {
                            //修改为排除
                            Update update = new Update();
                            update.set("status", 2);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, PaperIncludeOrExclude.class);
                            excludeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    }else {
                        excludeList.add(new PaperIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 2, userId, System.currentTimeMillis()));
                    }
                }
                if (!excludeList.isEmpty()) {
                    Collection<PaperIncludeOrExclude> insert = mongoTemplate.insert(excludeList, PaperIncludeOrExclude.class);
                    if (CollectionUtils.isNotEmpty(insert)) {
                        excludeFlag2 = true;
                    }
                }
                if (excludeFlag1 || excludeFlag2) {
                    flag = true;
                }
                break;
            case 5:
                List<PaperCollect> collectList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("paperId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    boolean exists = mongoTemplate.exists(query, PaperCollect.class);
                    if (!exists){
                        collectList.add(new PaperCollect(UUID.randomUUID().toString(), conditionId, id, userId, System.currentTimeMillis()));
                    }
                }
                if (!collectList.isEmpty()) {
                    Collection<PaperCollect> insert = mongoTemplate.insert(collectList, PaperCollect.class);
                    if (CollectionUtils.isNotEmpty(insert)) {
                        flag = true;
                    }
                }
                break;
            default:
                break;
        }
        return flag;
    }

    
    
    /**
     * 计算所有类型的总数量并打印详细信息
     * @param globalTypeSelectedCount 各类型已选择数量的映射
     * @return 总数量
     */
    private int getTotalSelectedCountWithDetails(Map<Integer, Integer> globalTypeSelectedCount) {
        if (globalTypeSelectedCount == null || globalTypeSelectedCount.isEmpty()) {
            log.debug("类型计数映射为空");
            return 0;
        }

        int total = 0;
        StringBuilder details = new StringBuilder("各类型统计: ");

        for (Map.Entry<Integer, Integer> entry : globalTypeSelectedCount.entrySet()) {
            Integer type = entry.getKey();
            Integer count = entry.getValue();
            if (count != null) {
                total += count;
                details.append("类型").append(type).append(":").append(count).append("篇, ");
            }
        }

        log.debug("{} 总计: {}篇", details.toString(), total);
        return total;
    }

    private List<SearchHit<PaperIndex>> executeSearchWithIndices(Condition condition, List<Integer> indices, List<PaperIndex> alternativeOne, List<PaperIndex> alternativeTwo, List<PaperIndex> alternativeThree, List<PaperIndex> alternativeFour) {
        // 将原searchWithSynonymCombination中while循环内的逻辑提取到这里
        BoolQueryBuilder paperQuery = new BoolQueryBuilder();

        boolean shouldData = false;
        
        // 期刊限制
        List<String> zhJournal = condition.getZhJournal();
        List<String> enJournal = condition.getEnJournal();

        if (CollectionUtils.isNotEmpty(zhJournal) || CollectionUtils.isNotEmpty(enJournal)) {
            shouldData = true;
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            if (zhJournal.size() == 5) {
                boolQueryBuilder.should().add(QueryBuilders.termQuery("language", "zh"));
            }
            if (CollectionUtils.isNotEmpty(zhJournal) && zhJournal.size() < 5) {
                for (String journal : zhJournal) {
                    BoolQueryBuilder zhBoolQueryBuilder = QueryBuilders.boolQuery();
                    zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "zh"));
                    switch (journal) {
                        case "北大核心":
                            journal = "Peking University";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "科技核心":
                            journal = "Technology";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "南大核心":
                            journal = "Nanjing University";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "CSCD":
                            journal = "CSCD";
                            zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("journalDivision.keyword", journal));
                            break;
                        case "其他":
                            BoolQueryBuilder otherBool = QueryBuilders.boolQuery().mustNot(QueryBuilders.existsQuery("journalDivision"));
                            zhBoolQueryBuilder.must().add(otherBool);
                            break;
                        default:
                            break;
                    }
                    boolQueryBuilder.should().add(zhBoolQueryBuilder);
                }
            }

            if (enJournal.size() == 6) {
                boolQueryBuilder.should().add(QueryBuilders.termQuery("language", "en"));
            }
            if (CollectionUtils.isNotEmpty(enJournal) && enJournal.size() < 6) {
                if (enJournal.contains("其他")) {
                    BoolQueryBuilder enBoolQueryBuilder = QueryBuilders.boolQuery();
                    enBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "en"));
                    BoolQueryBuilder otherBool = QueryBuilders.boolQuery().mustNot(QueryBuilders.existsQuery("journalDivision"));
                    enBoolQueryBuilder.must().add(otherBool);
                    boolQueryBuilder.should().add(enBoolQueryBuilder);
                    enJournal.remove("其他");
                }
                if (CollectionUtils.isNotEmpty(enJournal)) {
                    List<String> levelList = enJournal.stream().map(str -> {
                        int left = str.indexOf("Q");
                        int right = str.indexOf(")");
                        return str.substring(left + 1, right);
                    }).sorted().collect(Collectors.toList());

                    String highLevel = levelList.get(0);
                    for (String level : levelList) {
                        // 5 是需要变为 JCR N/A  其他的为 JCR Q1-4
                        if ("5".equals(level)) {
                            level = "N/A";
                        } else {
                            level = "Q" + level;
                        }
                        BoolQueryBuilder enBoolQueryBuilder = QueryBuilders.boolQuery();
                        enBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "en"));
                        MultiMatchQueryBuilder journalBoolQueryBuilder = QueryBuilders.multiMatchQuery("journalDivision", "SCIE (" + level + ")", "ESCI (" + level + ")", "SSCI (" + level + ")", "AHCI (" + level + ")");
                        journalBoolQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                        journalBoolQueryBuilder.operator(Operator.AND);
                        enBoolQueryBuilder.must().add(journalBoolQueryBuilder);
                        boolQueryBuilder.should().add(enBoolQueryBuilder);
                    }
                }
            }
            paperQuery.must().add(boolQueryBuilder);
        }

        // 年份
        int starYear = 1998;
        int endYear = LocalDate.now().getYear();
        // 年份限制
        String startSearchYear = condition.getLiteratureStartYear();
        String endSearchYear = condition.getLiteratureEndYear();

        if (StringUtils.isNotBlank(startSearchYear)) {
            starYear = Integer.parseInt(startSearchYear);
        }
        if (StringUtils.isNotBlank(endSearchYear)) {
            endYear = Integer.parseInt(endSearchYear);
        }
        paperQuery.must().add(QueryBuilders.rangeQuery("year").gte(starYear).lte(endYear));

        // 文献类型
        List<Integer> studyType = condition.getStudyType();
        BoolQueryBuilder studyTypeBool = new BoolQueryBuilder();
        // 类型限制
        if (CollectionUtils.isNotEmpty(studyType)) {
            for (Integer type : studyType) {
                if (CollUtil.containsAny(Arrays.asList(0, 2, 3, 14), Collections.singletonList(type))) {
//                if (CollUtil.containsAny(Arrays.asList(2), Collections.singletonList(type))) {
                    if (type == 14) {
                        studyTypeBool.should().add(QueryBuilders.termQuery("type", 7));
                    } else {
                        studyTypeBool.should().add(QueryBuilders.termQuery("lastNewType", type));
                    }
                }
            }
        }
        paperQuery.must().add(studyTypeBool);

        BoolQueryBuilder query = QueryUtils.createPaperQueryWithCombo(condition, 1, indices);
        paperQuery.must().add(query);

        List<String> drugSynonym = handleDrugToSynonym(condition.getDrugs());
        List<String> diseaseSynonym = handleDiseaseToSynonym(condition.getDiseases());

        List<String> handledDrugToSynonymForSearch = handleDrugToSynonymForSearch(condition.getDrugs());
        List<String> handleDiseaseToSynonymForSearch = handleDiseaseToSynonymForCustomer(condition, indices);

        String combinedScriptStr =
                "double baseScore = Math.log1p(_score + 1) * 0.5; " +
                        "double incompleteWeight = 1.0; " +
                        "if(doc['isIncomplete'].size() > 0 && doc['isIncomplete'].value == 1) { " +
                        "  incompleteWeight = 0.1; " +
                        "} " +
                        "double languageWeight = 1.0; " +
                        "if(doc['language'].size() > 0 && doc['language'].value == 'zh') { " +
                        "  languageWeight = 0.7; " +
                        "} " +
                        "double lastNewTypeWeight = 1.0; " +
                        "if(doc['lastNewType'].size() > 0) { " +
                        "  for(int i=0; i<doc['lastNewType'].length; i++) { " +
                        "    int intValue = Integer.parseInt(doc['lastNewType'][i].toString()); " +
                        "    if(intValue == 0 || intValue == 2 || intValue == 3) { " +
                        "      lastNewTypeWeight = 2; " +
                        "      break; " +
                        "    } " +
                        "  } " +
                        "} " +
                        "return baseScore * incompleteWeight * languageWeight * lastNewTypeWeight;";

        Script combinedScript = new Script(combinedScriptStr);
        ScriptScoreFunctionBuilder combinedScriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(combinedScript);

        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[1];
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(combinedScriptScoreFunctionBuilder);
        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(paperQuery, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
        nativeSearchQuery.setMaxResults(520);

        SearchHits<PaperIndex> search = null;
        if (shouldData) {
            // 执行查询
            try {
                search = RetryUtils.retry(
                        () -> elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class),
                        3,
                        1000,  // 每次重试间隔1秒
                        e -> true  // 对所有异常都重试，你也可以自定义条件，例如只对网络异常重试
                );
            } catch (Exception e) {
                log.error("文献纳入查询错误: {}", e.getMessage(), e);
            }
        }
        
        if (search == null) return new ArrayList<>();
        
        // 过滤符合条件的SearchHit
        return search.getSearchHits().stream()
                .filter(hit -> {
                    PaperIndex content = hit.getContent();
                    String title = content.getTitle();
                    List<String> keywords = content.getKeywords();
                    String keywordStr = String.join("|", keywords);
                    List<Integer> lastNewType = content.getLastNewType();
                    List<String> ic = content.getIc();
                    String summary = content.getSummary();
                    List<String> p = content.getP();
                    
                    if (condition.getDrugs().size() ==1 && StrUtil.containsAny(title, "联合", "联用")) {
                        return false;
                    }

                    if (CollUtil.containsAny(lastNewType, Arrays.asList(0, 2, 3))) {
                        // 第一个条件：如果title同时包含drug和disease，保留
                        if (checkFullWordContain(title, handledDrugToSynonymForSearch) &&
                                checkFullWordContain(title, handleDiseaseToSynonymForSearch)) {
                            return true;
                        }

                        // 第二个条件：如果summary不为空，且满足条件则保留
                        if (StringUtils.isNotBlank(keywordStr)) {
                           if ((checkFullWordContain(title, handledDrugToSynonymForSearch) ||
                                    checkFullWordContain(keywordStr, handledDrugToSynonymForSearch))
                                    && (checkFullWordContain(title, handleDiseaseToSynonymForSearch) ||
                                    checkFullWordContain(keywordStr, handleDiseaseToSynonymForSearch))) return true;

                        }
                        
                        if (ic != null && !ic.isEmpty() && p != null && !p.isEmpty()) {
                            String icStr = String.join("|", ic);
                            String pStr = String.join("|", p);
                            if (checkFullWordContain(pStr, handleDiseaseToSynonymForSearch) && checkFullWordContain(icStr, handledDrugToSynonymForSearch)) {
                                alternativeOne.add(content); 
                            }
                        }

                        if (p != null && !p.isEmpty()) {
                            String pStr = String.join("|", p);
                            if (checkFullWordContain(pStr, handleDiseaseToSynonymForSearch) && checkFullWordContain(title, handledDrugToSynonymForSearch)) {
                                alternativeTwo.add(content);
                            }
                        }

                        if (ic != null && !ic.isEmpty()) {
                            String icStr = String.join("|", ic);
                            if (checkFullWordContain(title, handleDiseaseToSynonymForSearch) && checkFullWordContain(icStr, handledDrugToSynonymForSearch)) {
                                alternativeThree.add(content);
                            }
                        }

                        if ((checkFullWordContain(title, handledDrugToSynonymForSearch) || checkFullWordContain(keywordStr, handledDrugToSynonymForSearch) || checkFullWordContain(summary, handledDrugToSynonymForSearch)) 
                                        && (checkFullWordContain(title, handleDiseaseToSynonymForSearch) || checkFullWordContain(keywordStr, handleDiseaseToSynonymForSearch) || checkFullWordContain(summary, handleDiseaseToSynonymForSearch))) {
                            alternativeFour.add(content);
                        }
                        
                        return false;
                    }
                    return false; // 其他情况不保留
                })
                .collect(Collectors.toList());
    }

    private List<String> handleDiseaseToSynonymForCustomer(Condition condition, List<Integer> indices) {
        List<Disease> diseases = condition.getDiseases().stream().filter(o -> o.getStatus() == 1).collect(Collectors.toList());

        if (indices == null || indices.size() != diseases.stream().filter(o -> o.getStatus() == 1).count()) {
            throw new IllegalArgumentException("Indices size must match diseases size.");
        }

        Set<String> set = new HashSet<>();

        for (int i = 0; i < diseases.size(); i++) {

            Disease disease = diseases.get(i);

            String word = disease.getWord();
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
                int index = indices.get(i) % sortedKeys.size();
                String key = sortedKeys.get(index);

                if (!key.equals(word)) {
                    set = synonymMap.get(key);
                } else {
                    set.add(word);

                    String enWord = disease.getEnWord();
                    if (StringUtils.isNotBlank(enWord)){
                        set.add(enWord.toLowerCase());
                        set.add(enWord);
                    }

                    String zhWord = disease.getZhWord();
                    if (StringUtils.isNotBlank(zhWord)){
                        set.add(zhWord.toLowerCase());
                        set.add(zhWord);
                    }

                    List<WordStatus> enSynonym = disease.getEnSynonym();
                    if (CollectionUtils.isNotEmpty(enSynonym)){
                        for (WordStatus wordStatus : enSynonym) {
                            String name = wordStatus.getName();
                            Boolean checked = wordStatus.getChecked();
                            if (checked) {
                                set.add(name.toLowerCase());
                                set.add(name);
                            }
                        }
                    }

                    List<WordStatus> zhSynonym = disease.getZhSynonym();
                    if (CollectionUtils.isNotEmpty(zhSynonym)){
                        for (WordStatus wordStatus : zhSynonym) {
                            String name = wordStatus.getName();
                            Boolean checked = wordStatus.getChecked();
                            if (checked) {
                                set.add(name.toLowerCase());
                                set.add(name);
                            }
                        }
                    }

                    List<WordStatus> otherSynonym = disease.getOtherSynonym();
                    if (CollectionUtils.isNotEmpty(otherSynonym)){
                        for (WordStatus wordStatus : otherSynonym) {
                            String name = wordStatus.getName();
                            Boolean checked = wordStatus.getChecked();
                            if (checked) {
                                set.add(name.toLowerCase());
                                set.add(name);
                            }
                        }
                    }

                    //补充同义词
                    String expandSynonym = disease.getExpandSynonym();
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StringUtils.isNotBlank(txt)) {
                            set.add(txt.toLowerCase());
                            set.add(txt);
                        }
                    }

                    List<String> expandedWords = disease.getExpandedWords();
                    if (CollectionUtils.isNotEmpty(expandedWords)) {
                        set.addAll(expandedWords.stream().distinct().map(String::valueOf).map(String::toLowerCase).collect(Collectors.toSet()));
                    }

                    set = set.stream().map(MedicalTermFilter::filterSemanticWords).filter(StringUtils::isNotBlank).collect(Collectors.toSet());
                }
            }
        }

        return new ArrayList<>(set);
    }

    private Map<String, List<PaperIndex>> filterByYearAndGroupByLanguage(List<SearchHit<PaperIndex>> searchHits, Condition condition) {
        return searchHits.stream().map(SearchHit::getContent).filter(paperIndex -> {
            if (Objects.nonNull(paperIndex.getYear())) {
                String literatureEndYear = condition.getLiteratureEndYear();
                if (StrUtil.isBlank(literatureEndYear)) literatureEndYear = String.valueOf(LocalDate.now().getYear() - 30);
                List<Integer> lastNewType = paperIndex.getLastNewType();
                if (CollUtil.containsAny(lastNewType, Arrays.asList(0, 2, 3))) {
                    if (Integer.parseInt(paperIndex.getYear()) >= Integer.parseInt(literatureEndYear) - 20) {
                        return StringUtils.isNotBlank(paperIndex.getLanguage());
                    }
                } else {
                    if (Integer.parseInt(paperIndex.getYear()) >= Integer.parseInt(literatureEndYear) - 10) {
                        return StringUtils.isNotBlank(paperIndex.getLanguage());
                    }
                }
            }
            return false;
        }).collect(Collectors.groupingBy(PaperIndex::getLanguage));
    }

    private void filterPaperByLanguageWithQuota(Map<String, List<PaperIndex>> languageGroup,
                                                List<MongoLiterature> mongoLiteratures,
                                                FineScreenFeign fineScreenFeign,
                                                int remainingQuota,
                                                Map<Integer, Integer> globalTypeSelectedCount,
                                                int currentRound, 
                                                Set<String> ids) {

        // 如果没有剩余配额，直接返回
        if (remainingQuota <= 0) {
            return;
        }

        // 使用剩余配额作为本轮的总配额
        final int TOTAL_QUOTA = remainingQuota;

        // 其他逻辑保持不变，但需要：
        // 1. 使用CURRENT_QUOTA替代原来的TOTAL_QUOTA
        // 2. 更新globalTypeSelectedCount而不是局部的typeSelectedCount
        // 3. 考虑已有的类型数量，动态调整各类型的需求量

        // ... 原有的筛选逻辑，但配额和计数使用传入的参数 ...

        // 配置必须纳入的类型及其最少数量
        Map<Integer, Integer> requiredTypeMinCountFirstRound = new HashMap<>();
        requiredTypeMinCountFirstRound.put(0, 20);
        requiredTypeMinCountFirstRound.put(2, 20);
        requiredTypeMinCountFirstRound.put(3, 10);

        Map<Integer, Integer> requiredTypeMinCountTwoRound = new HashMap<>();
        requiredTypeMinCountTwoRound.put(0, 20);
        requiredTypeMinCountTwoRound.put(2, 20);
        requiredTypeMinCountTwoRound.put(3, 10);

        // 类型权重配置（数值越大权重越高）
        Map<Integer, Integer> typeWeights = new HashMap<>();
        typeWeights.put(0, 100);
        typeWeights.put(2, 100);
        typeWeights.put(3, 99);
        typeWeights.put(7, 1);

        // 收集所有文献并添加权重信息
        List<WeightedPaper> weightedPapers = new ArrayList<>();

        // 处理英文文献
        List<PaperIndex> enPapers = languageGroup.get("en");
        if (CollectionUtils.isNotEmpty(enPapers)) {
            for (PaperIndex paper : enPapers) {
                if (StringUtils.isNotBlank(paper.getId())) {
                    try {
                        MongoLiterature mongoLiterature = fineScreenFeign.paper(paper.getId());
                        if (Objects.nonNull(mongoLiterature)) {
                            List<Integer> lastNewType = mongoLiterature.getLastNewType();
                            if (CollectionUtils.isNotEmpty(lastNewType)) {
                                int weight = typeWeights.getOrDefault(lastNewType.get(0), 1);
                                weightedPapers.add(new WeightedPaper(mongoLiterature, weight, "en"));
                            }
                        }
                    } catch (Exception e) {
                        log.error("获取英文文献时错误，paperId: {}, error: {}", paper.getId(), e.getMessage(), e);
                    }
                }
            }
        }

        // 处理中文文献
        List<PaperIndex> zhPapers = languageGroup.get("zh");
        if (CollectionUtils.isNotEmpty(zhPapers)) {
            for (PaperIndex paper : zhPapers) {
                if (StringUtils.isNotBlank(paper.getId())) {
                    try {
                        MongoLiterature mongoLiterature = fineScreenFeign.paper(paper.getId());
                        if (Objects.nonNull(mongoLiterature)) {
                            List<Integer> lastNewType = mongoLiterature.getLastNewType();
                            if (CollectionUtils.isNotEmpty(lastNewType)) {
                                int weight = typeWeights.getOrDefault(lastNewType.get(0), 1);
                                weightedPapers.add(new WeightedPaper(mongoLiterature, weight, "zh"));
                            }
                        }
                    } catch (Exception e) {
                        log.error("获取中文文献时错误，paperId: {}, error: {}", paper.getId(), e.getMessage(), e);
                    }
                }
            }
        }

        // 按类型分组
        Map<Integer, List<WeightedPaper>> typeGrouped = weightedPapers.stream()
                .collect(Collectors.groupingBy(wp -> wp.literature.getLastNewType().get(0)));

        List<MongoLiterature> selectedPapers = new ArrayList<>();
//        Map<Integer, Integer> typeSelectedCount = new HashMap<>();

        // 第一阶段：确保每个必须类型都有最少数量
        for (Map.Entry<Integer, Integer> entry : requiredTypeMinCountFirstRound.entrySet().stream()
                .sorted(Collections.reverseOrder(Map.Entry.comparingByValue()))
                .collect(Collectors.toMap(
                        Map.Entry::getKey,
                        Map.Entry::getValue,
                        (oldValue, newValue) -> oldValue,
                        LinkedHashMap::new
                )).entrySet()) {
            Integer type = entry.getKey();
            Integer minCount = entry.getValue();

            List<WeightedPaper> papersOfType = typeGrouped.get(type);
            if (CollectionUtils.isNotEmpty(papersOfType)) {
                // 按权重排序，权重高的优先  多余步骤
                papersOfType.sort((a, b) -> Integer.compare(b.weight, a.weight));

                // 计算要拿多少文献
                int actualCount = Math.min(minCount, papersOfType.size());
                actualCount = Math.min(actualCount, TOTAL_QUOTA - selectedPapers.size());

                List<Integer> useNumber = new ArrayList<>();
                for (int i = 0; i < papersOfType.size(); i++) {
                    if (useNumber.size() == actualCount) break;
                    if (ids.add(papersOfType.get(i).literature.getId())) {
                        if (type == 0 || type == 2 || type ==3) {    
//                        MongoLiterature literature = papersOfType.get(i).literature;
//                        String summary = literature.getSummary();
//                        String title = literature.getTitle();

                            selectedPapers.add(papersOfType.get(i).literature);
                            globalTypeSelectedCount.put(type, globalTypeSelectedCount.getOrDefault(type, 0) + 1);
                            useNumber.add(i);

//                        if (checkFullWordContain(title, drugSynonym) && checkFullWordContain(title, diseaseSynonym)) {
//                            selectedPapers.add(papersOfType.get(i).literature);
//                            globalTypeSelectedCount.put(type, globalTypeSelectedCount.getOrDefault(type, 0) + 1);
//                            useNumber.add(i);
//                            continue;
//                        }
//
//                        if (StringUtils.isNotBlank(summary)) {
//                            if ((checkFullWordContain(title, drugSynonym) || checkFullWordContain(summary, drugSynonym))
//                                    && (checkFullWordContain(title, diseaseSynonym) || checkFullWordContain(summary, diseaseSynonym))) {
//                                selectedPapers.add(papersOfType.get(i).literature);
//                                globalTypeSelectedCount.put(type, globalTypeSelectedCount.getOrDefault(type, 0) + 1);
//                                useNumber.add(i);
//                            }
//                        }

                        } else {
                            selectedPapers.add(papersOfType.get(i).literature);
                            globalTypeSelectedCount.put(type, globalTypeSelectedCount.getOrDefault(type, 0) + 1);
                            useNumber.add(i);
                        }
                    }
                }

                // 1️⃣ 去重（可选）
                Set<Integer> uniqueIndices = new LinkedHashSet<>(useNumber);
                useNumber.clear();
                useNumber.addAll(uniqueIndices);
                // 2️⃣ 排序为降序（关键：从后往前删除，避免索引错位）
                useNumber.sort(Collections.reverseOrder());
                // 3️⃣ 逐个删除
                for (int index : useNumber) {
                    if (index >= 0 && index < papersOfType.size()) {
                        papersOfType.remove(index);
                    } else {
                        // 可选：处理非法索引
                        System.out.println("非法索引：" + index);
                    }
                }
                
                
                
//                // 从原列表中移除已选择的
//                papersOfType.subList(0, actualCount).clear();
            }
        }

        // 暂时不用
//        // 第二阶段：填充剩余配额，按权重选择
//        Set<Integer> completeType = typeSelectedCount.keySet();
//        if (!CollUtil.containsAny(completeType, Arrays.asList(0, 2, 3))) {
//            Map<Integer, List<WeightedPaper>> filterTypeGrouped = typeGrouped.entrySet().stream().filter(map -> StrUtil.equalsAny(map.getKey() + "", "0", "2", "3")).collect(Collectors.toMap(
//                    Map.Entry::getKey,
//                    Map.Entry::getValue
//            ));
//
//            // 按权重 分配数量
//            Map<Integer, Integer> requiredAllocation = allocateBasedOnWeights(TOTAL_QUOTA, typeWeights);
//            // 进行分配
//            selectPapers(filterTypeGrouped, requiredAllocation, selectedPapers, typeSelectedCount);
////            List<WeightedPaper> remainingPapers = filterTypeGrouped.values().stream()
////                    .flatMap(List::stream)
////                    .sorted((a, b) -> Integer.compare(b.weight, a.weight))
////                    .collect(Collectors.toList());
////
////            int remainingQuota = TOTAL_QUOTA - selectedPapers.size();
////            for (int i = 0; i < Math.min(remainingQuota, remainingPapers.size()); i++) {
////                WeightedPaper wp = remainingPapers.get(i);
////                selectedPapers.add(wp.literature);
////                Integer type = wp.literature.getLastNewType().get(0);
////                typeSelectedCount.put(type, typeSelectedCount.getOrDefault(type, 0) + 1);
////            }
//        }

        // 添加到结果列表并计算统计
        mongoLiteratures.addAll(selectedPapers);

        // 输出选择结果统计
        log.info("第{}轮文献选择完成，总计: {}/{} 篇", currentRound, selectedPapers.size(), TOTAL_QUOTA);
        log.info("第{}轮各类型选择统计: {}", currentRound, globalTypeSelectedCount);
    }

    // 内部类，用于包装文献和权重信息
    private static class WeightedPaper {
        MongoLiterature literature;
        int weight;
        String language;

        public WeightedPaper(MongoLiterature literature, int weight, String language) {
            this.literature = literature;
            this.weight = weight;
            this.language = language;
        }
    }

    public static Map<Integer, Integer> allocateBasedOnWeights(int totalQuota, Map<Integer, Integer> typeWeights) {
        Map<Integer, Integer> result = new HashMap<>();
        int sumWeights = typeWeights.values().stream().mapToInt(Integer::intValue).sum();
        Map<Integer, Double> raw = new HashMap<>();

        // 1. 初始分配：按权重比例下取整
        for (Map.Entry<Integer, Integer> entry : typeWeights.entrySet()) {
            int type = entry.getKey();
            double percent = entry.getValue() / (double) sumWeights;
            double rawCount = percent * totalQuota;
            raw.put(type, rawCount);
            result.put(type, (int) Math.floor(rawCount));
        }

        // 2. 剩余名额按小数部分排序补全
        int remaining = totalQuota - result.values().stream().mapToInt(Integer::intValue).sum();
        List<Integer> sortedTypes = new ArrayList<>(typeWeights.keySet());
        sortedTypes.sort((a, b) -> Double.compare(raw.get(b) % 1, raw.get(a) % 1)); // 按小数部分排序

        // 3. 补足剩余名额
        for (Integer type : sortedTypes) {
            if (remaining <= 0) break;
            result.put(type, result.get(type) + 1);
            remaining--;
        }

        return result;
    }

    public static void selectPapers(Map<Integer, List<WeightedPaper>> filterTypeGrouped, Map<Integer, Integer> requiredAllocation, List<MongoLiterature> selectedPapers, Map<Integer, Integer> typeSelectedCount) {
        for (Map.Entry<Integer, List<WeightedPaper>> entry : filterTypeGrouped.entrySet()) {
            int type = entry.getKey();
            List<WeightedPaper> papers = entry.getValue();

            // 按权重排序
            papers.sort((a, b) -> Integer.compare(b.weight, a.weight));

            // 选取前 requiredAllocation[type] 篇
            int amount = requiredAllocation.getOrDefault(type, 0);
            for (int i = 0; i < Math.min(amount, papers.size()) && i < amount; i++) {
                WeightedPaper wp = papers.get(i);
                selectedPapers.add(wp.literature);
                typeSelectedCount.put(type, typeSelectedCount.getOrDefault(type, 0) + 1);
            }
        }
    }


    @Override
    public Boolean updateQuality(String id, String paperId, Integer quality, Long userId) {
        boolean flag = false;
        Query query = new Query(Criteria.where("paperId").is(paperId).and("userId").is(userId).and("conditionId").is(id));
        PaperQuality paperQuality = mongoTemplate.findOne(query, PaperQuality.class);
        if (paperQuality != null) {
            Integer integer = paperQuality.getQuality();
            if (!quality.equals(integer)) {
                Update update = new Update();
                update.set("quality", quality);
                update.set("timeStamp", System.currentTimeMillis());
                UpdateResult updateResult = mongoTemplate.updateFirst(query, update, PaperQuality.class);
                flag = updateResult.getMatchedCount() > 0;
            }
        }else {
            PaperQuality newPaperQuality = new PaperQuality(UUID.randomUUID().toString(), paperId, id, userId, quality, System.currentTimeMillis());
            try {
                mongoTemplate.save(newPaperQuality);
                flag = true;
            } catch (Exception e) {
                log.error("存储修改质量内容异常[{}]", e.getCause() != null ? e.getCause().getMessage() : e.toString());
            }
        }
        return flag;
    }

    @Override
    public void export(PaperExportDto paperExportDto, HttpServletResponse response) {
        response.setCharacterEncoding("UTF-8");
        Integer type = paperExportDto.getType();
        List<String> ids = paperExportDto.getIds();
        if (type == 3) {
            //开始构建xml
            response.setContentType("application/octet-stream");
            response.setHeader("Content-Disposition", "attachment;fileName=" + DateUtil.format(new Date(), "yyyyMMddHHmmss") + ".xml");
            Document document = DocumentHelper.createDocument();
            Element records = document.addElement("records");
            for (String id : ids) {
                MongoLiterature literatureMapping = fineScreenFeign.paper(id);
                if (literatureMapping != null) {
                    XmlUtils.batchExportXml(records, literatureMapping);
                }
            }
            ServletOutputStream outputStream;
            OutputFormat format = OutputFormat.createPrettyPrint();
            format.setEncoding("UTF-8");
            try {
                outputStream = response.getOutputStream();
                XMLWriter xmlWriter = new XMLWriter(outputStream, format);
                xmlWriter.write(document);
                outputStream.flush();
                IoUtil.close(outputStream);
                xmlWriter.close();
            } catch (IOException e) {
                log.error("课题导出失败{}", e.getMessage(), e);
            }
        } else if (type == 1) {
            //开始构建excel
            response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=utf-8");
            response.setHeader("Content-Disposition", "attachment;fileName=" + DateUtil.format(new Date(), "yyyyMMddHHmmss") + ".xlsx");
            ExcelWriter writer = ExcelUtil.getWriter(true);
            List<List<String>> rows = new ArrayList<>();
            List<String> row = CollUtil.newArrayList("标题", "作者", "摘要", "期刊", "年份", "影响因子");
            rows.add(row);
            for (String id : ids) {
                //------------本地环境暂时使用正式环境的mongo进行文献的查询----------
                MongoLiterature literatureMapping = null;
                try {
                    literatureMapping = fineScreenFeign.paper(id);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
                if (literatureMapping != null) {
                    //标题
                    String title = literatureMapping.getTitle() != null ? literatureMapping.getTitle() : "";
                    //作者
                    StringBuilder authorBuilder = new StringBuilder();
                    List<String> author = literatureMapping.getAuthor();
                    if (CollectionUtils.isNotEmpty(author)) {
                        for (int i = 0; i < author.size() - 1; i++) {
                            authorBuilder.append(author.get(i)).append(", ");
                        }
                        authorBuilder.append(author.get(author.size() - 1));
                    }
                    //摘要
                    String summary = literatureMapping.getSummary() != null ? literatureMapping.getSummary() : "";
                    //期刊
                    String journal = literatureMapping.getJournal() != null ? literatureMapping.getJournal() : "";
                    //年份
                    String year = literatureMapping.getYear() != null ? literatureMapping.getYear() : "";
                    //影响因子
                    String jcr = literatureMapping.getJcr() != null ? literatureMapping.getJcr().toString() : "";
                    row = CollUtil.newArrayList(title, authorBuilder.toString(), summary, journal, year, jcr);
                    rows.add(row);
                }
            }
            writer.write(rows);
            ServletOutputStream outputStream;
            try {
                outputStream = response.getOutputStream();
                writer.flush(outputStream, true);
                writer.close();
                outputStream.flush();
                IoUtil.close(outputStream);
            } catch (IOException e) {
                log.error(e.getMessage(), e);
            }
        } else {
            //开始构建pdf
            response.setContentType("application/octet-stream");
            response.setHeader("Content-Disposition", "attachment;fileName=" + DateUtil.format(new Date(), "yyyyMMddHHmmss") + ".pdf");
            com.itextpdf.text.Document document = new com.itextpdf.text.Document(PageSize.A4);
            ServletOutputStream outputStream = null;
            try {
                outputStream = response.getOutputStream();
                PdfWriter.getInstance(document, outputStream);
            } catch (IOException | DocumentException e) {
                log.error(e.getMessage(), e);
            }
            document.open();
            for (String id : ids) {
                MongoLiterature literatureMapping = null;
                try {
                    literatureMapping = fineScreenFeign.paper(id);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
                if (literatureMapping != null) {
                    //标题
                    String title = literatureMapping.getTitle() != null ? literatureMapping.getTitle() : "";
                    //作者
                    StringBuilder authorBuilder = new StringBuilder();
                    List<String> author = literatureMapping.getAuthor();
                    if (CollectionUtils.isNotEmpty(author)) {
                        for (int i = 0; i < author.size() - 1; i++) {
                            authorBuilder.append(author.get(i)).append(", ");
                        }
                        authorBuilder.append(author.get(author.size() - 1));
                    }
                    //摘要
                    String summary = literatureMapping.getSummary() != null ? literatureMapping.getSummary() : "";
                    //期刊
                    String journal = literatureMapping.getJournal() != null ? literatureMapping.getJournal() : "";
                    //关键词
                    StringBuilder keywordBuilder = new StringBuilder();
                    List<String> allKeyword = literatureMapping.getAllKeyword();
                    if (CollectionUtils.isNotEmpty(allKeyword)) {
                        for (int i = 0; i < allKeyword.size() - 1; i++) {
                            keywordBuilder.append(allKeyword.get(i)).append(", ");
                        }
                        keywordBuilder.append(allKeyword.get(allKeyword.size() - 1));
                    }
                    try {
//                        Font font = new Font(null, 12, Font.NORMAL);
//                        Font font = new Font(BaseFont.createFont("STSong-Light", "UniGB-UCS2-H", BaseFont.NOT_EMBEDDED), 10, Font.NORMAL);
                        Font font = new Font(BaseFont.createFont(BaseFont.HELVETICA, BaseFont.WINANSI, BaseFont.NOT_EMBEDDED), 10, Font.NORMAL);
                        document.add(new Paragraph("%A " + authorBuilder, font));
                        document.add(new Paragraph("%X " + summary, font));
                        document.add(new Paragraph("%T " + title, font));
                        document.add(new Paragraph("%K " + keywordBuilder, font));
                        document.add(new Paragraph("%U " + journal, font));
                        document.add(new Paragraph("", font));
                        document.add(new Paragraph("", font));
                    } catch (DocumentException | IOException e) {
                        log.error(e.getMessage(), e);
                    }
                }
            }
            try {
                document.close();
                if (outputStream != null) {
                    outputStream.flush();
                }
                IoUtil.close(outputStream);
            } catch (IOException e) {
                log.error(e.getMessage(), e);
            }
        }
    }

    @Override
    public PageVo<PaperVo> showPaperCollect(Long userId, String searchWord, Integer pageSize, Integer pageNum) {
        List<PaperCollect> collectList = mongoTemplate.find(new Query(Criteria.where("userId").is(userId)), PaperCollect.class);
        List<String> ids = new ArrayList<>();
        collectList.forEach(collect -> ids.add(collect.getPaperId()));
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(ids.toArray(new String[0])));
        if (StringUtils.isNotBlank(searchWord)) {
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(searchWord, "title", "summary", "author", "year", "journal");
            multiMatchQueryBuilder.operator(Operator.AND);
            //使用精准查询
            multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            multiMatchQueryBuilder.field("title", 24F);
            boolQueryBuilder.must().add(multiMatchQueryBuilder);
        }
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        nativeSearchQuery.setPageable(PageRequest.of(pageNum - 1, pageSize));
        //高亮
        String preTag = "<b>";
        String postTag = "</b>";
        HighlightBuilder highlightBuilder = new HighlightBuilder();
        highlightBuilder.field("title");
        highlightBuilder.field("summary");
        highlightBuilder.preTags(preTag);
        highlightBuilder.postTags(postTag);
        highlightBuilder.fragmentSize(1024 * 10);
        highlightBuilder.numOfFragments(0);
        highlightBuilder.requireFieldMatch(false);
        nativeSearchQuery.setHighlightQuery(new HighlightQuery(highlightBuilder));
        nativeSearchQuery.setTrackTotalHits(true);
        SearchHits<PaperIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class);
        List<PaperVo> list = new ArrayList<>();
        for (SearchHit<PaperIndex> searchHit : searchHits) {
            PaperIndex content = searchHit.getContent();
            String contentId = content.getId();

            //------------本地环境暂时使用正式环境的mongo进行文献的查询----------
            MongoLiterature mongoLiterature = null;
            try {
                mongoLiterature = fineScreenFeign.paper(contentId);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            if (mongoLiterature != null) {
                //高亮显示情况
                List<String> titleList = searchHit.getHighlightField("title");
                List<String> summaryList = searchHit.getHighlightField("summary");
                StringBuilder titleBuilder = new StringBuilder();
                StringBuilder summaryBuilder = new StringBuilder();
                if (CollectionUtils.isNotEmpty(titleList)) {
                    titleList.forEach(titleBuilder::append);
                }
                if (CollectionUtils.isNotEmpty(summaryList)) {
                    summaryList.forEach(summaryBuilder::append);
                }
                mongoLiterature.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? mongoLiterature.getTitle() : highLight(titleBuilder.toString(), mongoLiterature.getTitle(), null, searchWord));
                mongoLiterature.setSummary(StringUtils.isBlank(summaryBuilder.toString()) ? mongoLiterature.getSummary() : highLight(summaryBuilder.toString(), mongoLiterature.getSummary(), null, searchWord));
                PaperVo paperVo = FormatUtil.formatPaper(mongoLiterature);
                if (userId != null) {
                    //用户上传的pdf
                    PaperUpload paperUpload = mongoTemplate.findById(contentId, PaperUpload.class);
                    if (paperUpload != null) {
                        String fileUrl = paperUpload.getFileUrl();
                        paperVo.setFileUrl(fileUrl);
                    }
                }
                list.add(paperVo);
            }
        }
        long totalHits = searchHits.getTotalHits();
        int pages = (int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1);
        PageVo<PaperVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        return page;
    }

    @Override
    public void excludeReason(ExcludeReasonVo excludeReasonVo, long userId) {
        String literatureId = excludeReasonVo.getId();
        if (StrUtil.isBlank(literatureId)) {
            DataResult.error("不正确的文献id！！！");
            return;
        }
        ExcludeReasonBo excludeReasonBo = new ExcludeReasonBo();
        BeanUtils.copyProperties(excludeReasonVo, excludeReasonBo);
        excludeReasonBo.setUserId(userId);
        DateTime updateTime = DateTime.now();
        excludeReasonBo.setUpdateTime(updateTime);
        long time = updateTime.getTime();
        excludeReasonBo.setUpdateTimeLong(time);
        mongoTemplate.save(excludeReasonBo);
    }

    /**
     * 内部方法，拼接处理修改后质量显示问题的逻辑
     * @param ids1 勾选
     * @param ids2 勾选/不勾选
     * @param ids3 不勾选
     * @param inIds 用户修改后当前查询
     * @param outIds 用户修改后非当前查询
     * @param status 1-1个勾选；2-2个勾选
     */
    private void qualityBool(List<String> ids1, List<String> ids2, List<String> ids3, List<String> inIds, List<String> outIds, Integer status) {
        if (status == 1) {
            //用户只勾选了1个质量等级
            if (CollectionUtils.isNotEmpty(ids1)) {
                inIds.addAll(ids1);
            }
            if (CollectionUtils.isNotEmpty(ids2)) {
                outIds.addAll(ids2);
            }
            if (CollectionUtils.isNotEmpty(ids3)) {
                outIds.addAll(ids3);
            }
        } else {
            //用户勾选了2个质量等级
            if (CollectionUtils.isNotEmpty(ids1)) {
                inIds.addAll(ids1);
            }
            if (CollectionUtils.isNotEmpty(ids2)) {
                inIds.addAll(ids2);
            }
            if (CollectionUtils.isNotEmpty(ids3)) {
                outIds.addAll(ids3);
            }
        }
    }

    @Override
    public BoolQueryBuilder useMode(String mode, String zhEnExtension, String synonymExtension) {
        // 目前没有去验证 mode 的正确性 所以 searh 的时候是会报错的
        String PATTERN = "\\s+AND\\s+|\\s+NOT\\s+|\\s+OR\\s+";
        String PATTERN_ = "AND|NOT|OR";
        String[] termStrs = mode.split(PATTERN);
        if (termStrs.length == 0 || termStrs.length == 1) {
            termStrs = mode.split(PATTERN_);
        }
        // 正则匹配 AND, NOT, OR 操作符
        Pattern pattern = Pattern.compile("\\b(AND|NOT|OR)\\b");
        Matcher matcher = pattern.matcher(mode);
        // 存储匹配到的逻辑运算符
        List<String> operators = new ArrayList<>();
        while (matcher.find()) {
            operators.add(matcher.group());
        }

        List<String> assembleTerms = new ArrayList<>();
        if (termStrs.length > 0) {
            List<String> terms = Arrays.stream(termStrs).collect(Collectors.toList());
            for (String term : terms) {
                term = term.replaceAll("（", "(");
                term = term.replaceAll("）", ")");
                term = term.replaceAll("【", "[");
                term = term.replaceAll("】", "]");
                StringBuilder originTerm = new StringBuilder(term);
                if (term.contains("(")) {
                    term = term.replaceAll("\\(", "");
                }
                if (term.contains(")")) {
                    term = term.replaceAll("\\)", "");
                }
                if (term.contains("[")) {
                    term = term.substring(0, term.indexOf("["));
                }
                if (term.contains("]")) {
                    term = term.substring(0, term.indexOf("["));
                }
                JSONObject synonym = retrievalService.synonym(term, 1, 1);

                Set<String> synonymSet = new HashSet<>();
                Set<String> zhEnsynonymSet = new HashSet<>();
                boolean equal = term.length() == term.getBytes().length;
                if (Objects.nonNull(synonym)) {
                    JSONObject zhSynonym = synonym.getJSONObject("zh");
                    JSONObject enSynonym = synonym.getJSONObject("en");
                    JSONObject otherSynonym = synonym.getJSONObject("other");

                    if ("1".equals(zhEnExtension)) {
                        if (Objects.nonNull(zhSynonym)) {
                            List<String> synonymListZh = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            synonymSet.addAll(synonymListZh);
                            synonymSet.add(zhSynonym.getString("name"));
                            zhEnsynonymSet.add(zhSynonym.getString("name"));
                        }
                        if (Objects.nonNull(enSynonym)) {
                            List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            synonymSet.addAll(synonymListEn);
                            synonymSet.add(enSynonym.getString("name"));
                            zhEnsynonymSet.add(enSynonym.getString("name"));
                        }
                        if (Objects.nonNull(otherSynonym)) {
                            List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(otherSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            synonymSet.addAll(synonymListOther);
                        }
                    } else {
                        if (equal) {
                            if (Objects.nonNull(enSynonym)) {
                                List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                                });
                                synonymSet.addAll(synonymListEn);
                                synonymSet.add(enSynonym.getString("name"));
                                zhEnsynonymSet.add(enSynonym.getString("name"));
                            }
                        } else {
                            if (Objects.nonNull(zhSynonym)) {
                                List<String> synonymListZh = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                                });
                                synonymSet.addAll(synonymListZh);
                                synonymSet.add(zhSynonym.getString("name"));
                                zhEnsynonymSet.add(zhSynonym.getString("name"));
                            }
                        }
                        if (Objects.nonNull(otherSynonym)) {
                            List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(otherSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                            });
                            synonymSet.addAll(synonymListOther);
                        }
                    }
                }

                // 组装 query
                String range = extractRange(originTerm.toString());

                String tail = "";
                if (StrUtil.endWith(originTerm, ")")) {
                    tail = originTerm.substring(originTerm.indexOf(")"));
                    originTerm = new StringBuilder(originTerm.substring(0, originTerm.indexOf(")")));
                }

                if ("1".equals(synonymExtension)) {
                    if (CollectionUtils.isNotEmpty(synonymSet)) {
                        for (String o : synonymSet) {
                            if ("全部".equals(range) || StrUtil.isBlank(range)) {
                                originTerm.append(" OR ").append(o);
                            } else {
                                originTerm.append(" OR ").append(o).append("[").append(range).append("]");
                            }
                        }
                    }
                } else {
                    if ("1".equals(zhEnExtension)) {
                        if (CollectionUtils.isNotEmpty(zhEnsynonymSet)) {
                            for (String o : zhEnsynonymSet) {
                                if ("全部".equals(range) || StrUtil.isBlank(range)) {
                                    originTerm.append(" OR ").append(o);
                                } else {
                                    originTerm.append(" OR ").append(o).append("[").append(range).append("]");
                                }
                            }
                        }
                    }
                }
                originTerm.append(tail);
                assembleTerms.add(originTerm.toString());
            }
        }

        StringBuilder newMode = new StringBuilder();
        if (CollectionUtils.isNotEmpty(assembleTerms)) {
            for (int i = 0; i < assembleTerms.size(); i++) {
                String term = assembleTerms.get(i);
                if (i == assembleTerms.size() - 1) {
                    newMode.append(term);
                } else {
                    newMode.append(term).append(" ").append(operators.get(i)).append(" ");
                }
            }
        }
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        String formula = FormulaFeignUtils.formula(StrUtil.replace(newMode, "[全部]", ""), 1);
        boolQuery.must().add(QueryBuilders.wrapperQuery(formula));
        return boolQuery;
    }

    private String extractRange(String originTerm) {
        String result = "";
        if (originTerm.contains("[") || originTerm.contains("]")) {
            if (originTerm.contains("[")) {
                originTerm = originTerm.substring(originTerm.indexOf("[") + 1);
            }
            if (originTerm.contains("]")) {
                originTerm = originTerm.substring(0, originTerm.indexOf("]"));
            }
            result = originTerm;
        }
        return result;
    }
    public List<PaperVo> processPapers(SearchHits<PaperIndex> searchHits, String id, Long userId, List<String> stopWord, Condition condition, String search, ExecutorService executorService) {
        // 使用流将每条数据包装为 CompletableFuture
        List<CompletableFuture<PaperVo>> futures = searchHits.stream()
                .map(searchHit -> CompletableFuture.supplyAsync(() -> processPaper(searchHit, id, userId, stopWord, condition, search), executorService))
                .collect(Collectors.toList());

        // 等待所有任务完成并收集结果

        return futures.stream()
                .map(CompletableFuture::join) 
                .filter(Objects::nonNull) 
                .collect(Collectors.toList());
    }

    private PaperVo processPaper(SearchHit<PaperIndex> searchHit, String id, Long userId, List<String> stopWord, Condition condition, String search) {
        PaperIndex content = searchHit.getContent();
        String contentId = content.getId();
        
        MongoLiterature mongoLiterature = fineScreenFeign.paper(contentId);
        if (mongoLiterature != null) {
            //高亮显示情况
            List<String> titleList = searchHit.getHighlightField("title");
            List<String> summaryList = searchHit.getHighlightField("summary");
            
            StringBuilder titleBuilder = new StringBuilder();
            if (CollectionUtils.isNotEmpty(titleList)) {
                titleList.forEach(titleBuilder::append);
            }
            StringBuilder summaryBuilder = new StringBuilder();
            if (CollectionUtils.isNotEmpty(summaryList)) {
                summaryList.forEach(summaryBuilder::append);
            }
            mongoLiterature.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? mongoLiterature.getTitle() : highLight(HighLightUtils.repairContent(titleBuilder.toString(), content.getTitle(), stopWord), mongoLiterature.getTitle(), condition, search));
            mongoLiterature.setSummary(StringUtils.isBlank(summaryBuilder.toString()) ? mongoLiterature.getSummary() : highLight(HighLightUtils.repairContent(summaryBuilder.toString(), content.getSummary(), stopWord), mongoLiterature.getSummary(), condition, search));

            PaperVo paperResponse = FormatUtil.formatPaper(mongoLiterature);
            PdfAnalysis pdfAnalysis = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(mongoLiterature.getId()).and("questionId").is(id)), PdfAnalysis.class);
            if (Objects.nonNull(pdfAnalysis) && Objects.nonNull(pdfAnalysis.getSuccess()) && pdfAnalysis.getSuccess() && StringUtils.isNotBlank(pdfAnalysis.getOnePicUrl())) {
                paperResponse.setPdfToPicVo(new PdfToPicVo(pdfAnalysis.getImagesCount(), pdfAnalysis.getOnePicUrl()));
            }
            // 质量评价结果
            PdfEditResult paperEditResult = pdfEditResultService.getPaperEditResultPaperIdAndQuestionId(mongoLiterature.getId(), id, "");
            if (Objects.nonNull(paperEditResult)) {
                String qualityMeta = paperEditResult.getQualityMeta();
                if (StringUtils.isNotBlank(qualityMeta)) {
                    paperResponse.setQualityMeta(qualityMeta);
                }
            }

            if (userId != null) {
                Criteria criteria = Criteria.where("paperId").is(contentId).and("userId").is(userId).and("conditionId").is(id);
                //判断纳入/排除情况
                PaperIncludeOrExclude includeOrExclude = mongoTemplate.findOne(new Query(criteria), PaperIncludeOrExclude.class);
                if (includeOrExclude != null) {
                    Integer status = includeOrExclude.getStatus();
                    paperResponse.setBringIntoOrExcludeMark(status);
                }
                //判断收藏情况
                PaperCollect collect = mongoTemplate.findOne(new Query(criteria), PaperCollect.class);
                if (collect != null) {
                    paperResponse.setCollectionMark(1);
                }
                //判断质量等级修改情况
                PaperQuality paperQuality = mongoTemplate.findOne(new Query(criteria), PaperQuality.class);
                if (paperQuality != null) {
                    paperResponse.setQuality(String.valueOf(paperQuality.getQuality()));
                }
                //用户上传的pdf
                PaperUpload paperUpload = mongoTemplate.findById(contentId, PaperUpload.class);
                if (paperUpload != null) {
                    String fileUrl = paperUpload.getFileUrl();
                    paperResponse.setFileUrl(fileUrl);
                }
            }
            return paperResponse;
        }
        return null;
    }

    private String buildScriptByDrugAndDisease(List<String> drugSynonym, List<String> diseaseSynonym) {
        StringBuilder result = new StringBuilder();
        result.append("def disease = false; def drug = false;");

        if (CollectionUtils.isNotEmpty(diseaseSynonym)) {
            result.append("if (params.title != null) { def nameLower = params.title.toLowerCase(); ");
            result.append("if (");
            for (int i = 0; i < diseaseSynonym.size(); i++) {
                result.append("nameLower.contains('").append(diseaseSynonym.get(i)).append("')");
                if (i < diseaseSynonym.size() - 1) {
                    result.append(" || ");
                }
            }
            result.append(") { disease = true; }}");
        }

        if (CollectionUtils.isNotEmpty(drugSynonym)) {
            result.append("if (params.title != null) { def nameLower = params.title.toLowerCase(); ");
            result.append("if (");
            for (int i = 0; i < drugSynonym.size(); i++) {
                result.append("nameLower.contains('").append(drugSynonym.get(i)).append("')");
                if (i < drugSynonym.size() - 1) {
                    result.append(" || ");
                }
            }
            result.append(") { drug = true; }}");
        }

        result.append("if (disease && drug) { return 1000; } else if (disease) { return 500; } else if (drug) { return 250; } else { return 0; }");
        return result.toString();
    }

    private List<String> handleDiseaseToSynonym(List<Disease> diseases) {
        Set<String> set = new HashSet<>();
        for (Disease disease : diseases) {
            Integer status = disease.getStatus();
            if (status == 1){
                set.add(disease.getWord().toLowerCase());
                set.add(disease.getWord());

                String enWord = disease.getEnWord();
                if (StringUtils.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

                List<WordStatus> enSynonym = disease.getEnSynonym();
                if (CollectionUtils.isNotEmpty(enSynonym)){
                    for (WordStatus wordStatus : enSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                String zhWord = disease.getZhWord();
                if (StringUtils.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

                List<WordStatus> zhSynonym = disease.getZhSynonym();
                if (CollectionUtils.isNotEmpty(zhSynonym)){
                    for (WordStatus wordStatus : zhSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                List<WordStatus> otherSynonym = disease.getOtherSynonym();
                if (CollectionUtils.isNotEmpty(otherSynonym)){
                    for (WordStatus wordStatus : otherSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                //补充同义词
                String expandSynonym = disease.getExpandSynonym();
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
            }
        }

        if (CollectionUtils.isNotEmpty(set)) {
            set = set.stream().filter(s -> {
                boolean english = s.length() == s.getBytes().length;
                return !english || s.length() >= 2;
            }).map(str -> {
                if (StrUtil.contains(str,"*")) {
                    return str.replaceAll("\\*", "");
                }
                return str;
            }).collect(Collectors.toSet());
        }
        return new ArrayList<>(set);

    }

    private List<String> handleDrugToSynonym(List<Drug> drugs) {
        Set<String> set = new HashSet<>();
        for (Drug drug : drugs) {
            Integer status = drug.getStatus();
            if (status == 1){
                set.add(drug.getWord().toLowerCase());
                set.add(drug.getWord());

                String enWord = drug.getEnWord();
                if (StringUtils.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

                List<WordStatus> enSynonym = drug.getEnSynonym();
                if (CollectionUtils.isNotEmpty(enSynonym)){
                    for (WordStatus wordStatus : enSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                String zhWord = drug.getZhWord();
                if (StringUtils.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

                List<WordStatus> zhSynonym = drug.getZhSynonym();
                if (CollectionUtils.isNotEmpty(zhSynonym)){
                    for (WordStatus wordStatus : zhSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                List<WordStatus> otherSynonym = drug.getOtherSynonym();
                if (CollectionUtils.isNotEmpty(otherSynonym)){
                    for (WordStatus wordStatus : otherSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                //补充同义词
                String expandSynonym = drug.getExpandSynonym();
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
            }
        }

        if (CollectionUtils.isNotEmpty(set)) {
            set = set.stream().filter(s -> {
                boolean english = s.length() == s.getBytes().length;
                return !english || s.length() >= 2;
            }).map(str -> {
                if (StrUtil.contains(str,"*")) {
                    return str.replaceAll("\\*", "");
                }
                return str;
            }).collect(Collectors.toSet());
        }

        return new ArrayList<>(set);

    }

    private List<String> handleDiseaseToSynonymForSearch(List<Disease> diseases) {
        Set<String> set = new HashSet<>();
        for (Disease disease : diseases) {
            Integer status = disease.getStatus();
            if (status == 1){
                set.add(disease.getWord().toLowerCase());
                set.add(disease.getWord());

                String enWord = disease.getEnWord();
                enWord = enWord.replaceAll("([+'])", "\\\\$1");
                if (StringUtils.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

//                List<WordStatus> enSynonym = disease.getEnSynonym();
//                if (CollectionUtils.isNotEmpty(enSynonym)){
//                    for (WordStatus wordStatus : enSynonym) {
//                        String name = wordStatus.getName();
//                        name = name.replaceAll("([+'])", "\\\\$1");
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            set.add(name);
//                        }
//                    }
//                }

                String zhWord = disease.getZhWord();
                zhWord = zhWord.replaceAll("([+'])", "\\\\$1");
                if (StringUtils.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

//                List<WordStatus> zhSynonym = disease.getZhSynonym();
//                if (CollectionUtils.isNotEmpty(zhSynonym)){
//                    for (WordStatus wordStatus : zhSynonym) {
//                        String name = wordStatus.getName();
//                        name = name.replaceAll("([+'])", "\\\\$1");
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            set.add(name);
//                        }
//                    }
//                }
//
//                List<WordStatus> otherSynonym = disease.getOtherSynonym();
//                if (CollectionUtils.isNotEmpty(otherSynonym)){
//                    for (WordStatus wordStatus : otherSynonym) {
//                        String name = wordStatus.getName();
//                        name = name.replaceAll("([+'])", "\\\\$1");
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            set.add(name);
//                        }
//                    }
//                }
//
//                //补充同义词
//                String expandSynonym = disease.getExpandSynonym();
//                if (StringUtils.isNotBlank(expandSynonym)) {
//                    expandSynonym = expandSynonym.replaceAll("；", ";");
//                    String[] split = expandSynonym.split(";");
//                    for (String txt : split) {
//                        if(StringUtils.isNotBlank(txt)) {
//                            txt = txt.replaceAll("([+'])", "\\\\$1");
//                            set.add(txt.toLowerCase());
//                            set.add(txt);
//                        }
//                    }
//                }

                if (CollectionUtils.isNotEmpty(set)) {
                    set = set.stream().filter(s -> {
                        boolean english = s.length() == s.getBytes().length;
                        return !english || s.length() >= 2;
                    }).map(str -> {
                        if (StrUtil.contains(str,"*")) {
                            return str.replaceAll("\\*", "");
                        }
                        return str;
                    }).collect(Collectors.toSet());
                }

            }
        }
        return new ArrayList<>(set);

    }

    private List<String> handleDrugToSynonymForSearch(List<Drug> drugs) {
        Set<String> set = new HashSet<>();
        for (Drug drug : drugs) {
            Integer status = drug.getStatus();
            if (status == 1){
                set.add(drug.getWord().toLowerCase());
                set.add(drug.getWord());

                String enWord = drug.getEnWord();
                enWord = enWord.replaceAll("([+'])", "\\\\$1");
                if (StringUtils.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

                List<WordStatus> enSynonym = drug.getEnSynonym();
                if (CollectionUtils.isNotEmpty(enSynonym)){
                    for (WordStatus wordStatus : enSynonym) {
                        String name = wordStatus.getName();
                        name = name.replaceAll("([+'])", "\\\\$1");
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                String zhWord = drug.getZhWord();
                zhWord = zhWord.replaceAll("([+'])", "\\\\$1");
                if (StringUtils.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

                List<WordStatus> zhSynonym = drug.getZhSynonym();
                if (CollectionUtils.isNotEmpty(zhSynonym)){
                    for (WordStatus wordStatus : zhSynonym) {
                        String name = wordStatus.getName();
                        name = name.replaceAll("([+'])", "\\\\$1");
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                List<WordStatus> otherSynonym = drug.getOtherSynonym();
                if (CollectionUtils.isNotEmpty(otherSynonym)){
                    for (WordStatus wordStatus : otherSynonym) {
                        String name = wordStatus.getName();
                        name = name.replaceAll("([+'])", "\\\\$1");
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }


                //补充同义词
                String expandSynonym = drug.getExpandSynonym();
                if (StringUtils.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StringUtils.isNotBlank(txt)) {
                            txt = txt.replaceAll("([+'])", "\\\\$1");
                            set.add(txt.toLowerCase());
                            set.add(txt);
                        }
                    }
                }

                List<String> zhDrugNames = drug.getZhDrugNames();
                if (CollectionUtils.isNotEmpty(zhDrugNames)) {
                    set.addAll(zhDrugNames);
                }

                List<String> enDrugNames = drug.getEnDrugNames();
                if (CollectionUtils.isNotEmpty(enDrugNames)) {
                    set.addAll(enDrugNames);
                }
            }
        }

        if (CollectionUtils.isNotEmpty(set)) {
            set = set.stream().map(MedicalTermFilter::filterSemanticWords).filter(StringUtils::isNotBlank).collect(Collectors.toSet());
            set = set.stream().filter(s -> {
                boolean english = s.length() == s.getBytes().length;
                return !english || s.length() >= 2;
            }).map(str -> {
                if (StrUtil.contains(str,"*")) {
                    return str.replaceAll("\\*", "");
                }
                return str;
            }).collect(Collectors.toSet());
        }

        return new ArrayList<>(set);

    }


    public static boolean checkFullWordContain(String text, List<String> synonym) {
        boolean match = false;

        text = text.replaceAll("\n", "");
        boolean chinese = text.matches(".*[一-\u9fff].*");
        boolean english = text.matches(".*[a-zA-Z].*");
        if (english) {
            for (String word : synonym) {
                // 对特殊字符进行转义
                word = word.replaceAll("([+\\-\\[\\]{}()*^$.|?])", "\\\\$1");
                // 使用正则表达式来匹配完整的单词
                String pattern = "\\b" + word + "\\b";
                Pattern compiledPattern = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE);
                Matcher matcher = compiledPattern.matcher(text);
                if (matcher.find()) {
                    match = true;
                    break;
                }
//                if (text.matches(".*" + pattern + ".*")) {
//                    match = true;
//                    break;
//                }
            }
            if (chinese) {
                match = StrUtil.containsAnyIgnoreCase(text, synonym.toArray(new String[0]));
            }
        } else {
            match = StrUtil.containsAnyIgnoreCase(text, synonym.toArray(new String[0]));
        }
        return match;
    }

    @Override
    public PageVo<String> getPdf(PdfRequestRequest pdfRequestRequest, long userId) {
        PageVo<String> pageVo = new PageVo<>();
        if (Objects.isNull(pdfRequestRequest)) {
            return pageVo;
        }
        if (StrUtil.isBlank(pdfRequestRequest.getId())) {
            return pageVo;
        }

        String questionId = pdfRequestRequest.getQuestionId();
        String paperId = pdfRequestRequest.getId();
        PdfAnalysis pdfAnalysis = new PdfAnalysis();
        pdfAnalysis.setId(paperId);
        pdfAnalysis.setSuccess(false); // 默认为 false 没有将 pdf 转为图片
        PdfAnalysis mongo = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(paperId).and("userId").is(userId).and("questionId").is(questionId)), PdfAnalysis.class);
        if (Objects.nonNull(mongo)) {
            pdfAnalysis = mongo;
        }

        // 因为图片的转换需要时间，所以需要等待pdf全部转为图片在返回成功
        // 这个地方可以用消息队列  后期更改优化一下
        if (Objects.nonNull(pdfAnalysis.getSuccess()) && !pdfAnalysis.getSuccess()) {
            try {
                for (int i = 0; i < 80; i++) { // 8 分钟足够 pdf 没有那么大 如果有就失败了
                    Thread.sleep(6000);
                    PdfAnalysis mongo_inner = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(paperId).and("userId").is(userId).and("questionId").is(questionId)), PdfAnalysis.class);
                    if (Objects.nonNull(mongo_inner)) {
                        // 看 pdf 是否转图片成功，如果失败就直接返回，成功跳出循环
                        if (!mongo_inner.getSuccess()) {
                            return pageVo;
                        } else {
                            pdfAnalysis = mongo_inner;
                            break; // 跳出 for
                        }
                    }
                }
            } catch (InterruptedException e) {
                log.error(e.getMessage(), e);
            }
        }

        if (Objects.nonNull(pdfAnalysis.getSuccess()) && pdfAnalysis.getSuccess()) {
            // 图片ftp路径 路径格式是 sftpPath/image_pdf/pdf名称/文献id_页码.type
            String ipFilePath = ""; // 公网可访问的图片路径
            if (StringUtils.isNotBlank(pdfAnalysis.getFilePath())) {
                ipFilePath = pdfAnalysis.getFilePath();
            }
            String type = pdfAnalysis.getType();
            // 当前请求页 ip remote path
            ipFilePath = CommonUtil.removeSeparatorFromSuffix(ipFilePath).concat(Constants.PAD_LEFT_SLASH).concat(paperId + "_" + (pdfRequestRequest.getPageNum() - 1)).concat(Constants.PAD_DOT).concat(type);

            String base64String = "";
            Session jschSession = null;
            ChannelSftp channelSftp;
            try {
                JSch jsch = new JSch();
                jschSession = jsch.getSession(sftpUserName, sftpHost, sftpPort);
                // 通过密码的方式登录认证
                jschSession.setPassword(sftpPassword);
                Properties properties = new Properties();
                properties.put("StrictHostKeyChecking", "no");
                jschSession.setConfig(properties);
                jschSession.connect(Constants.SESSION_TIMEOUT);
                // 建立sftp文件传输管道
                Channel sftp = jschSession.openChannel("sftp");
                sftp.connect(Constants.CHANNEL_TIMEOUT);
                channelSftp = (ChannelSftp) sftp;
                try {
                    // 在每个线程中获取或创建一个新的InputStream
                    InputStream inputStream = channelSftp.get(ipFilePath);
                    byte[] byteArray = IOUtils.toByteArray(inputStream);
                    base64String = Base64.getEncoder().encodeToString(byteArray);
                    base64String = "data:image/png;base64," + base64String;
                    inputStream.close();
                } catch (SftpException e) {
                    log.error(e.getMessage(), e);
                    log.error("转换图片时发生错误{}",e.getMessage());
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
                channelSftp.exit();
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (jschSession != null) {
                    try {
                        jschSession.disconnect();
                    } catch (Exception e) {
                        log.warn(e.getMessage(), e);
                    }
                }
            }

            long total = pdfAnalysis.getImagesCount();
            Integer pageSize = pdfRequestRequest.getPageSize();
            int pages = (int) (total % pageSize == 0 ? total / pageSize : total / pageSize + 1);
            pageVo.setPageSize(pdfRequestRequest.getPageSize());
            pageVo.setPageNum(pdfRequestRequest.getPageNum());
//            pageVo.setList(new ArrayList<>(Collections.singletonList(ipFilePath)));
            pageVo.setList(new ArrayList<>(Collections.singletonList(base64String)));
            pageVo.setTotal(total);
            pageVo.setPages(pages);
            return pageVo;
        }
        // 如果 8 分钟之后还是没有解析成功 认为失败
        pageVo.setPageSize(pdfRequestRequest.getPageSize());
        pageVo.setPageNum(pdfRequestRequest.getPageNum());
        pageVo.setList(new ArrayList<>());
        pageVo.setTotal(0L);
        pageVo.setPages(0);
        return pageVo;
    }

    @Override
    public Boolean savePaperStandard(PaperStandardRequest paperStandardRequest) {
        // 参数校验
        if (Objects.isNull(paperStandardRequest)) {
            return false;
        }
        boolean isValidRequest = StringUtils.isNotBlank(paperStandardRequest.getPaperId())
                && StringUtils.isNotBlank(paperStandardRequest.getQuestionId())
                && StringUtils.isNotBlank(paperStandardRequest.getStandardId());
        if (!isValidRequest) {
            return false;
        }

        String paperId = paperStandardRequest.getPaperId();
        String questionId = paperStandardRequest.getQuestionId();
        String standardId = paperStandardRequest.getStandardId();
        String standardValue = paperStandardRequest.getStandardValue();

        // 查找已存在的记录
        PdfEdit existingPaperStandard = pdfEditService.getPaperStandardByPaperIdAndQuestionId(paperId, questionId, standardId);
        if (Objects.nonNull(existingPaperStandard)) {
            existingPaperStandard.setStandardValue(standardValue);
            pdfEditService.saveOrUpdate(existingPaperStandard);
        } else {
            PdfEdit newPdfEdit = new PdfEdit();
            BeanUtils.copyProperties(paperStandardRequest, newPdfEdit);

            // 设置必要的字段
            Snowflake snowflake = new Snowflake();
            newPdfEdit.setId(snowflake.nextIdStr());
            newPdfEdit.setCreateTime(new Date());
            newPdfEdit.setStatus(2); // 自定义内容
            pdfEditService.save(newPdfEdit);
        }
        return true;
    }

    @Override
    public Map<String, Object> transPaper(String id) {
        MongoLiterature paper = fineScreenFeign.paper(id);

        if (paper == null) { return new HashMap<>(); }

        Map<String, Object> paramMap = new HashMap<>();
        Map<String, Object> resultMap = new HashMap<>();

        String paperTransKey = RedisKeyConstant.getKey(RedisKeyConstant.PAPER_TRANS, id);
        String paperTrans = RedisUtils.getStr(paperTransKey);

        if (StringUtils.isNotBlank(paperTrans)) {
            resultMap = JSON.parseObject(paperTrans, new TypeReference<Map<String, Object>>() {
            });
            return resultMap;
        }
        
        String summary = paper.getSummary();
        String title = paper.getTitle();
        String tldr = paper.getTldr();
        String conclusin = paper.getConclusion();
        String method = paper.getMethod();
        String objective = paper.getObjective();
        String result = paper.getResult();

        paramMap.put("title", title);
        paramMap.put("summary", summary);
        paramMap.put("tldr", tldr);
        paramMap.put("conclusin", conclusin);
        paramMap.put("method", method);
        paramMap.put("objective", objective);
        paramMap.put("result", result);

        resultMap = aiService.trans(paramMap);
        RedisUtils.set(paperTransKey, JSON.toJSONString(resultMap),60 * 10, TimeUnit.SECONDS);
        
        return resultMap;
    }


    @Override
    public Map<String, Object> getAlgInitial(String paperId, String questionId, long userId, String studyType) {
        Date begin = new Date();
       

        // 验证文献类型
        MongoLiterature paperIndex = fineScreenFeign.paper(paperId);
        if (Objects.nonNull(paperIndex)) {
            Map<String, Object> result = new HashMap<>();
            List<Integer> lastNewType = paperIndex.getLastNewType();
//            if (CollectionUtils.isNotEmpty(lastNewType) && lastNewType.size() > 1 && lastNewType.contains(12) && "12".equals(studyType)) {
//                result.put("result", "2");
//                result.put("resultMsg", "多文献研究类型，系统不予以进行文献质量评价分析。");
//                return result;
//            }
            if (!Constants.ALG_STUDY_TYPES_META_RCT_ECONOMY.contains(studyType)) {
                result.put("result", "2");
                result.put("resultMsg", "系统质量分析只支持 Meta、RCT/nRCT、经济类型文献。");
                return result;
            }
        }

        Snowflake snowflake = new Snowflake();
        PdfAnalysis pdfAnalysis = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(paperId).and("userId").is(userId).and("questionId").is(questionId)), PdfAnalysis.class);
        List<PdfEdit> paperStandards = pdfEditService.getPaperStandardsByPaperIdAndQuestionId(paperId, questionId);

        // 如果已有解析结果且PDF未被替换，直接返回
        if (CollectionUtils.isNotEmpty(paperStandards) && Objects.nonNull(pdfAnalysis)) {
            if (Objects.equals(paperStandards.get(0).getPath(), pdfAnalysis.getPath())) {
                return processExistingResults(paperStandards, studyType, paperId, questionId, snowflake);
            } else {
                // PDF被替换，清除旧数据
                pdfEditService.deletePdfEditByPaperIdAndQuestionId(paperId, questionId);
                pdfEditResultService.deletePdfEditResultByPaperIdAndQuestionId(paperId, questionId);
            }
        }

        // 第一次访问或PDF被替换，需要解析
        return processNewAnalysis(begin, paperId, questionId, userId, studyType, snowflake);
    }

    private Map<String, Object> processNewAnalysis(Date begin, String paperId, String questionId,
                                                   long userId, String studyType, Snowflake snowflake) {
        long timeout = 1000 * 60 * 4; // 10分钟超时

        while (new Date().getTime() - begin.getTime() < timeout) {
            try {
                PdfAnalysis pdfAnalysis = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(paperId).and("userId").is(userId).and("questionId").is(questionId)), PdfAnalysis.class);

                if (Objects.nonNull(pdfAnalysis) &&
                        Objects.nonNull(pdfAnalysis.getAlgSuccess()) &&
                        pdfAnalysis.getAlgSuccess()) {
                    return processAnalysisData(pdfAnalysis, paperId, questionId, studyType, snowflake);

                }

                Thread.sleep(5000); // 等待5秒
                log.info("当前锁{}，等待时间是{}", paperId, new Date().getTime() - begin.getTime());

            } catch (Exception e) {
                log.error("解析异常: {}", e.getMessage(), e);
                Map<String, Object> result = new HashMap<>();
                result.put("result", "1");
                result.put("resultMsg", "解析失败。");
                return result;
            }
        }

        Map<String, Object> result = new HashMap<>();
        result.put("result", "2");
        result.put("resultMsg", "文献正在解析中，请稍后点击查看。");
        return result;
    }

    private Map<String, Object> processAnalysisData(PdfAnalysis pdfAnalysis, String paperId,
                                                    String questionId, String studyType, Snowflake snowflake) {
        JSONObject data = pdfAnalysis.getData();
        if (Objects.isNull(data)) {
            Map<String, Object> result = new HashMap<>();
            result.put("result", "1");
            result.put("resultMsg", "解析失败。");
            return result;
        }

        List<PdfEdit> pdfEdits = new ArrayList<>();
        List<AlgPdfModeVo> algPdfModeVos = new ArrayList<>();
        QualityStatistics stats = new QualityStatistics();

        JSONArray resultData = data.getJSONArray("result_data");
        if (resultData != null) {
            for (Object resultDatum : resultData) {
                JSONObject model = JSON.parseObject(JSON.toJSONString(resultDatum), JSONObject.class);

                AlgPdfModeVo algPdfModeVo = processModelData(model, studyType, stats);
                algPdfModeVos.add(algPdfModeVo);

                PdfEdit pdfEdit = PdfEdit.builder()
                        .id(snowflake.nextIdStr())
                        .paperId(paperId)
                        .paperType(studyType)
                        .questionId(questionId)
                        .standardId(algPdfModeVo.getModeId())
                        .title(algPdfModeVo.getTitle())
                        .titleTips(algPdfModeVo.getTitleTips())
                        .standardValue(algPdfModeVo.getPredict())
                        .body(algPdfModeVo.getBody())
                        .reason(algPdfModeVo.getReason())
                        .path(pdfAnalysis.getPath())
                        .status(0)
                        .createTime(new Date())
                        .build();
                pdfEdits.add(pdfEdit);
            }
        }

        // RCT类型需要添加固定的两个条目
        if ("2".equals(studyType)) {
            String path = pdfAnalysis.getPath();
            // 添加报告偏倚
            AlgPdfModeVo algPdfModeVo5 = new AlgPdfModeVo();
            algPdfModeVo5.setModeId("5");
            algPdfModeVo5.setTitle("报告偏倚");
            algPdfModeVo5.setTitleTips("报告偏倚");
            algPdfModeVo5.setBody(new JSONArray());
            algPdfModeVo5.setPredict("NC");
            algPdfModeVo5.setReason("");
            algPdfModeVos.add(algPdfModeVo5);

            PdfEdit pdfEdit5 = new PdfEdit(snowflake.nextIdStr(), paperId, "2", questionId, "5",
                    "报告偏倚", "报告偏倚", "NC", new JSONArray(), "", path, 0, new Date());
            pdfEdits.add(pdfEdit5);

            // 添加其他偏倚
            AlgPdfModeVo algPdfModeVo6 = new AlgPdfModeVo();
            algPdfModeVo6.setModeId("6");
            algPdfModeVo6.setTitle("其他偏倚");
            algPdfModeVo6.setTitleTips("其他偏倚");
            algPdfModeVo6.setBody(new JSONArray());
            algPdfModeVo6.setPredict("NC");
            algPdfModeVo6.setReason("");
            algPdfModeVos.add(algPdfModeVo6);

            PdfEdit pdfEdit6 = new PdfEdit(snowflake.nextIdStr(), paperId, "2", questionId, "6",
                    "其他偏倚", "其他偏倚", "NC", new JSONArray(), "", path, 0, new Date());
            pdfEdits.add(pdfEdit6);
        }

        // 保存评价结果
        if (CollectionUtils.isNotEmpty(pdfEdits)) {
            pdfEditService.saveOrUpdateBatch(pdfEdits);
        }

        // 构建返回数据
        AlgPdfAnalysisVo analysisVo = buildAnalysisVo(algPdfModeVos, studyType, stats);

        // 保存或更新结果统计
        saveOrUpdateResult(paperId, questionId, studyType, stats, snowflake);

        Map<String, Object> result = new HashMap<>();
        result.put("result", "3");
        result.put("resultMsg", "解析成功。");
        result.put("data", analysisVo);
        return result;
    }

    private AlgPdfModeVo processModelData(JSONObject model, String studyType, QualityStatistics stats) {
        AlgPdfModeVo algPdfModeVo = new AlgPdfModeVo();

        String modeId = model.getString("id");
        String reason = model.getString("reason");
        String predict = model.getString("predict");
        JSONArray reference = model.getJSONArray("reference");

        // 预测结果标准化
        if (!Constants.QUALITY_RESULT.contains(predict)) {
            predict = "2".equals(studyType) ? "NC" : "否";
        }

        algPdfModeVo.setModeId(modeId);
        algPdfModeVo.setReason(reason);
        algPdfModeVo.setPredict(predict);
        algPdfModeVo.setBody(reference);

        // 设置标题和提示
        String title = "";
        String titleTips = "";

        switch (studyType) {
            case "0":
                title = PaperEditMetaEnum.of(modeId).getTitle();
                titleTips = PaperEditMetaEnum.of(modeId).getTitleTips();
                break;
            case "2":
                title = PaperEditRctEnum.of(modeId).getTitle();
                titleTips = title;
                break;
            case "12":
                title = PaperEditEconomyEnum.of(modeId).getTitle();
                titleTips = title;
                break;
        }

        algPdfModeVo.setTitle(title);
        algPdfModeVo.setTitleTips(titleTips);

        // 更新统计数据
        if ("0".equals(studyType)) {
            stats.addMetaPredict(predict);
        } else if ("12".equals(studyType)) {
            stats.updateEconomyStatistics(predict);
        }

        return algPdfModeVo;
    }

    private Map<String, Object> processExistingResults(List<PdfEdit> paperStandards, String studyType,
                                                       String paperId, String questionId, Snowflake snowflake) {
        List<AlgPdfModeVo> algPdfModeVos = new ArrayList<>();
        QualityStatistics stats = new QualityStatistics();

        // 处理已有的评价结果
        for (PdfEdit paperStandard : paperStandards) {
            AlgPdfModeVo algPdfModeVo = buildAlgPdfModeVo(paperStandard);
            algPdfModeVos.add(algPdfModeVo);

            if ("0".equals(studyType)) {
                stats.addMetaPredict(paperStandard.getStandardValue());
            } else if ("12".equals(studyType)) {
                stats.updateEconomyStatistics(paperStandard.getStandardValue());
            }
        }

        // 构建返回数据
        AlgPdfAnalysisVo analysisVo = buildAnalysisVo(algPdfModeVos, studyType, stats);

        // 保存或更新结果
        saveOrUpdateResult(paperId, questionId, studyType, stats, snowflake);

        Map<String, Object> result = new HashMap<>();
        result.put("result", "3");
        result.put("resultMsg", "解析成功。");
        result.put("data", analysisVo);
        return result;
    }

    private void saveOrUpdateResult(String paperId, String questionId, String studyType,
                                    QualityStatistics stats, Snowflake snowflake) {
        PdfEditResult existingResult = pdfEditResultService.getPaperEditResultPaperIdAndQuestionId(paperId, questionId, "");

        if (Objects.nonNull(existingResult)) {
            updateExistingResult(existingResult, studyType, stats);
        } else {
            createNewResult(snowflake, paperId, studyType, questionId, stats);
        }
    }

    private void updateExistingResult(PdfEditResult result, String studyType, QualityStatistics stats) {
        if ("0".equals(studyType)) {
            result.setQualityMeta(stats.calculateMetaQuality());
        } else if ("12".equals(studyType)) {
            result.setYesNum(stats.getYesNum());
            result.setNoNum(stats.getNoNum());
            result.setPartNum(stats.getPartNum());
            result.setNotApplicableNum(stats.getNotApplicableNum());
            result.setOtherNum(stats.getOtherNum());
        }
        pdfEditResultService.saveOrUpdate(result);
    }

    private void createNewResult(Snowflake snowflake, String paperId, String studyType,
                                 String questionId, QualityStatistics stats) {
        String metaQuality = "0".equals(studyType) ? stats.calculateMetaQuality() : "";

        PdfEditResult newResult = new PdfEditResult(
                snowflake.nextIdStr(),
                paperId,
                studyType,
                questionId,
                metaQuality,
                stats.getYesNum(),
                stats.getNoNum(),
                stats.getPartNum(),
                stats.getNotApplicableNum(),
                stats.getOtherNum()
        );

        pdfEditResultService.save(newResult);
    }

    private AlgPdfModeVo buildAlgPdfModeVo(PdfEdit paperStandard) {
        AlgPdfModeVo algPdfModeVo = new AlgPdfModeVo();
        algPdfModeVo.setModeId(paperStandard.getStandardId());
        algPdfModeVo.setTitle(paperStandard.getTitle());
        algPdfModeVo.setTitleTips(paperStandard.getTitleTips());
        algPdfModeVo.setBody(paperStandard.getBody());
        algPdfModeVo.setReason(paperStandard.getReason());
        algPdfModeVo.setPredict(paperStandard.getStandardValue());
        return algPdfModeVo;
    }

    private AlgPdfAnalysisVo buildAnalysisVo(List<AlgPdfModeVo> algPdfModeVos, String studyType,
                                             QualityStatistics stats) {
        AlgPdfAnalysisVo analysisVo = new AlgPdfAnalysisVo();
        analysisVo.setAlgPdfModeVos(algPdfModeVos);
        analysisVo.setType(studyType);

        if ("0".equals(studyType)) {
            analysisVo.setQualityMeta(stats.calculateMetaQuality());
        } else if ("12".equals(studyType)) {
            analysisVo.setYesNum(stats.getYesNum());
            analysisVo.setNoNum(stats.getNoNum());
            analysisVo.setPartNum(stats.getPartNum());
            analysisVo.setNotApplicableNum(stats.getNotApplicableNum());
            analysisVo.setOtherNum(stats.getOtherNum());
        }

        return analysisVo;
    }


    @Override
    public Boolean savePaperInfo(PaperInfoEditRequest paperInfoEditRequest) {
        // 参数校验
        if (Objects.isNull(paperInfoEditRequest)) {
            return false;
        }
        boolean isValidRequest = StringUtils.isNotBlank(paperInfoEditRequest.getPaperId())
                && StringUtils.isNotBlank(paperInfoEditRequest.getQuestionId())
                && StringUtils.isNotBlank(paperInfoEditRequest.getInfoId());
        if (!isValidRequest) {
            return false;
        }
        
        String paperId = paperInfoEditRequest.getPaperId();
        String questionId = paperInfoEditRequest.getQuestionId();
        String infoId = paperInfoEditRequest.getInfoId();
        String content = paperInfoEditRequest.getContent();

        // 查询现有记录
        PaperInfo existingPaperInfo = paperInfoService.getPaperInfoByPaperIdAndQuestionId(paperId, questionId, infoId);
        if (Objects.isNull(existingPaperInfo)) {
            return false;
        }

        // 更新内容
        existingPaperInfo.setContent(content);
        paperInfoService.saveOrUpdate(existingPaperInfo);

        return true;
    }

    @Override
    public Map<String, Object> getInfoInitial(String paperId, String questionId, String studyType) {
        String pdfUrl = "";
        PaperInfoVo paperInfoVo = new PaperInfoVo();
        List<PaperInfoModeVo> paperInfoModeVos = new ArrayList<>();
        paperInfoVo.setPaperInfoModeVos(paperInfoModeVos);
        paperInfoVo.setPdfUrl(pdfUrl);

        Map<String, Object> result = new HashMap<>();
        if (StrUtil.isBlank(paperId) || StrUtil.isBlank(questionId)) {
            result.put("result", "2");
            result.put("resultMsg", "查看信息提取错误，请联系管理员！");
            return result;
        }

        List<PaperInfo> paperInfos = paperInfoService.getPaperContentsByPaperIdAndQuestionId(paperId, questionId);
        if (Objects.nonNull(paperInfos) && CollectionUtils.isNotEmpty(paperInfos)) {
            for (PaperInfo paperInfo : paperInfos) {
                PaperInfoModeVo paperInfoModeVo = new PaperInfoModeVo();
                paperInfoModeVo.setInfoId(paperInfo.getInfoId());
                paperInfoModeVo.setTitle(paperInfo.getTitle());
                paperInfoModeVo.setContent(paperInfo.getContent());
                paperInfoModeVos.add(paperInfoModeVo);
            }

            if (CollectionUtils.isNotEmpty(paperInfoModeVos)) {
                paperInfoVo.setPaperInfoModeVos(paperInfoModeVos);
                paperInfoVo.setPdfUrl(pdfUrl);
                result.put("result", "3");
                result.put("resultMsg", "解析成功！");
                result.put("data", paperInfoVo);
                return result;
            }
        }

        paperInfos = new ArrayList<>();
        IdsQueryBuilder idsQueryBuilder = new IdsQueryBuilder().addIds(paperId);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
        SearchHit<PaperIndex> paperIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, PaperIndex.class);
        if (Objects.nonNull(paperIndexSearchHit)) {
            PaperIndex content = paperIndexSearchHit.getContent();
            MongoLiterature mongoLiterature = fineScreenFeign.paper(content.getId());
//            MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findById(content.getId(), MongoLiterature.class, "mongo_literature_" + Math.abs(content.getId().hashCode()) % 10);
            if (Objects.nonNull(mongoLiterature)) {
                if (CollectionUtils.isNotEmpty(mongoLiterature.getLastNewType()) && Constants.OTHER_LITERATURE_TYPE.contains(studyType)) {
                    PaperInfoModeVo paperInfoModeVo = new PaperInfoModeVo();

                    List<String> author = mongoLiterature.getAuthor();
                    String year = mongoLiterature.getYear();
                    // 文献来源
                    String source = "";
                    if (CollectionUtils.isNotEmpty(author)) {
                        source = author.get(0) + " " + year;
                    } else {
                        source = "未知" + " " + year;
                    }
                    paperInfoModeVo.setInfoId("1");
                    paperInfoModeVo.setTitle("文献来源");
                    paperInfoModeVo.setContent(source);
                    paperInfoModeVos.add(paperInfoModeVo);
                    Snowflake snowflake = new Snowflake();
                    PaperInfo paperInfo = new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "1", "文献来源", StringUtils.isNotBlank(source) ? source : "-", pdfUrl);
                    paperInfos.add(paperInfo);
                    // 年份
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("2");
                    paperInfoModeVo.setTitle("年份");
                    paperInfoModeVo.setContent(year);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "2", "年份", StringUtils.isNotBlank(year) ? year : "-", pdfUrl));
                    // 研究类型
                    StringBuilder studyTypeBuilder = new StringBuilder();
                    if (CollectionUtils.isNotEmpty(mongoLiterature.getLastNewType())) {
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
                        if (CollectionUtils.isNotEmpty(mongoLiterature.getType())) {
                            if (mongoLiterature.getType().contains(7)) {
                                studyTypeBuilder.append("临床试验、");
                            }
                        }
                    } else {
                        if (CollectionUtils.isNotEmpty(mongoLiterature.getType())) {
                            if (mongoLiterature.getType().contains(7)) {
                                studyTypeBuilder.append("临床试验、");
                            }
                        } else {
                            studyTypeBuilder.append(" ");
                        }
                    }
                    // 研究类型
                    String studyTypeName = studyTypeBuilder.toString();
                    if (StringUtils.isNotBlank(studyTypeName)) {
                        studyTypeName = studyTypeName.substring(0, studyTypeName.length() - 1);
                    }
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("3");
                    paperInfoModeVo.setTitle("试验类型");
                    paperInfoModeVo.setContent(studyTypeName);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "3", "试验类型", StringUtils.isNotBlank(studyTypeName) ? studyTypeName : "-", pdfUrl));
                    // 实验组干预指标
                    List<String> ic = mongoLiterature.getIc();
                    String ic_str = "-";
                    if (CollectionUtils.isNotEmpty(ic)) {
                        ic_str = String.join("、", ic);
                    }
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("4");
                    paperInfoModeVo.setTitle("试验组");
                    paperInfoModeVo.setContent(ic_str);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "4", "试验组", StringUtils.isNotBlank(ic_str) ? ic_str : "-", pdfUrl));

                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("5");
                    paperInfoModeVo.setTitle("对照组");
                    paperInfoModeVo.setContent("-");
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "5", "对照组", "-", pdfUrl));
                    // 结局指标
                    String index = "-";
                    if (CollectionUtils.isNotEmpty(mongoLiterature.getO())) {
                        index = String.join("、", mongoLiterature.getO());
                    }
                    // 结果
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("6");
                    paperInfoModeVo.setTitle("结局指标");
                    paperInfoModeVo.setContent(index);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "6", "结局指标", StringUtils.isNotBlank(index) ? index : "-", pdfUrl));
                    // 结论
                    String conclusion = mongoLiterature.getConclusion();
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("7");
                    paperInfoModeVo.setTitle("结论");
                    paperInfoModeVo.setContent(conclusion);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "7", "结论", StringUtils.isNotBlank(conclusion) ? conclusion : "-", pdfUrl));
                    paperInfoVo.setPaperInfoModeVos(paperInfoModeVos);
                    paperInfoVo.setPdfUrl(pdfUrl);
                }
                // 经济类型的不一样
                if (CollectionUtils.isNotEmpty(mongoLiterature.getLastNewType()) && Constants.ECONOMY_LITERATURE_TYPE.contains(studyType)) {
                    PaperInfoModeVo paperInfoModeVo = new PaperInfoModeVo();
                    List<String> author = mongoLiterature.getAuthor();
                    String year = mongoLiterature.getYear();
                    // 来源
                    String source = author.get(0) + " " + year;
                    source = StringUtils.isNotBlank(source) ? source : "-";
                    paperInfoModeVo.setInfoId("1");
                    paperInfoModeVo.setTitle("文献来源");
                    paperInfoModeVo.setContent(source);
                    paperInfoModeVos.add(paperInfoModeVo);
                    Snowflake snowflake = new Snowflake();
                    PaperInfo paperInfo = new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "1", "文献来源", source, pdfUrl);
                    paperInfos.add(paperInfo);
                    // 年份
                    year = StringUtils.isNotBlank(year) ? year : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("2");
                    paperInfoModeVo.setTitle("年份");
                    paperInfoModeVo.setContent(year);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "2", "年份", year, pdfUrl));
                    // 研究国家
                    String country = StringUtils.isNotBlank(mongoLiterature.getEconomicsResearchCountry()) ? mongoLiterature.getEconomicsResearchCountry() : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("3");
                    paperInfoModeVo.setTitle("研究国家");
                    paperInfoModeVo.setContent(country);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "3", "研究国家", country, pdfUrl));
                    // 研究方法
                    String method = StringUtils.isNotBlank(mongoLiterature.getEconomicsEvaluationMethods()) ? mongoLiterature.getEconomicsEvaluationMethods() : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("4");
                    paperInfoModeVo.setTitle("研究方法");
                    paperInfoModeVo.setContent(method);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "4", "研究方法", method, pdfUrl));
                    // 研究方案
                    String ic = StringUtils.isNotBlank(mongoLiterature.getEconomicsIC()) ? mongoLiterature.getEconomicsIC() : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("5");
                    paperInfoModeVo.setTitle("研究方案");
                    paperInfoModeVo.setContent(ic);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "5", "研究方案", ic, pdfUrl));
                    // 对照方案
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("6");
                    paperInfoModeVo.setTitle("对照方案");
                    paperInfoModeVo.setContent(ic);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "6", "对照方案", ic, pdfUrl));
                    // 结局指标
                    String o = StringUtils.isNotBlank(mongoLiterature.getEconomicsO()) ? mongoLiterature.getEconomicsO() : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("7");
                    paperInfoModeVo.setTitle("结局指标");
                    paperInfoModeVo.setContent(o);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "7", "结局指标", o, pdfUrl));
                    // 结论
                    String conclusion = StringUtils.isNotBlank(mongoLiterature.getEconomicsConclusion()) ? mongoLiterature.getEconomicsConclusion() : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("8");
                    paperInfoModeVo.setTitle("结论");
                    paperInfoModeVo.setContent(conclusion);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "8", "结论", conclusion, pdfUrl));

                    paperInfoVo.setPaperInfoModeVos(paperInfoModeVos);
                    paperInfoVo.setPdfUrl(pdfUrl);
                }
            }
        }

        if (CollectionUtils.isNotEmpty(paperInfos)) {
            paperInfoService.saveOrUpdateBatch(paperInfos);
        }
        result.put("result", "3");
        result.put("resultMsg", "解析成功");
        result.put("data", paperInfoVo);
        return result;
    }

    @Override
    public Integer uploadPdf(PaperUploadRequest paperUploadRequest, long userId) {
        Date begin = new Date();
        String paperId = paperUploadRequest.getId();
        String questionId = paperUploadRequest.getQuestionId();

        // 参数校验
        if (StrUtil.isBlank(paperId)) {
            log.warn("paperId is blank");
            return 1;
        }

        try {
            // 1. 准备文件信息
            FileUploadInfo fileInfo = prepareFileInfo(paperUploadRequest);

            // 2. 建立SFTP连接
            SftpConnectionPair connections = establishSftpConnections();

            try {
                // 3. 处理已存在的文件
                PaperUpload existingUpload = findExistingUpload(paperId, userId);
                PdfAnalysis pdfAnalysis = findOrCreatePdfAnalysis(paperId, userId, questionId);

                if (existingUpload != null) {
                    handleExistingFile(connections, existingUpload, pdfAnalysis, paperId, questionId);
                }

                // 4. 上传新文件
                UploadResult uploadResult = uploadFiles(connections, fileInfo, paperUploadRequest.getFile());

                // 5. 保存上传记录
                boolean isUpdate = saveUploadRecord(paperId, userId, fileInfo, existingUpload != null);

                // 6. 发布图片解析事件
                publishPictureAnalysisEvent(paperId, questionId, userId, fileInfo,
                        paperUploadRequest.getType(), uploadResult);

                log.info("上传文献 id {}, pdf 上传完成花费时间{}ms", paperId,
                        new Date().getTime() - begin.getTime());

                return isUpdate ? 0 : 1;

            } finally {
                closeSftpConnections(connections);
            }

        } catch (Exception e) {
            log.error("PDF上传失败, paperId: {}, userId: {}", paperId, userId, e);
            return 1;
        }
    }


    /**
     * 关闭SFTP连接
     */
    private void closeSftpConnections(SftpConnectionPair connections) {
        if (connections != null) {
            connections.close();
        }
    }

    /**
     * 发布图片解析事件
     */
    private void publishPictureAnalysisEvent(String paperId, String questionId, long userId,
                                             FileUploadInfo fileInfo, String type, UploadResult uploadResult) {
        try {
            if (uploadResult.isMainSuccess()) {
                PictureAnalysisBo bo = new PictureAnalysisBo(
                        paperId, questionId, userId,
                        fileInfo.getRemotePath(), fileInfo.getFileNameUUID().toString(),
                        "png", fileInfo.getAlgRemoteFilePath(), "",
                        type, uploadResult.isAlgSuccess()
                );
                applicationEventPublisher.publishEvent(new PictureAnalysisEvent(this, bo));
            }
        } catch (Exception e) {
            log.error("发布图片解析事件失败", e);
        }
    }

    /**
     * 保存上传记录
     */
    private boolean saveUploadRecord(String paperId, long userId, FileUploadInfo fileInfo, boolean isUpdate) {
        if (isUpdate) {
            return updateExistingRecord(paperId, fileInfo, userId);
        } else {
            return createNewRecord(paperId, userId, fileInfo);
        }
    }

    /**
     * 创建新记录
     */
    private boolean createNewRecord(String paperId, long userId, FileUploadInfo fileInfo) {
        String id = new Snowflake().nextIdStr();
        PaperUpload paperUpload = new PaperUpload(
                id, paperId, userId, "chao", true,
                fileInfo.getRemoteFilePath(), fileInfo.getRemotePath(),
                fileInfo.getIpFilePath(), System.currentTimeMillis(),
                fileInfo.getAlgRemoteFilePath()
        );

        mongoTemplate.save(paperUpload);
        return true;
    }

    /**
     * 更新已存在的记录
     */
    private boolean updateExistingRecord(String paperId, FileUploadInfo fileInfo, long userId) {
        Update update = new Update()
                .set("filePath", fileInfo.getRemoteFilePath())
                .set("path", fileInfo.getRemotePath())
                .set("fileUrl", fileInfo.getIpFilePath())
                .set("timeStamp", System.currentTimeMillis())
                .set("userId", userId)
                .set("success", true)
                .set("filePath_alg", fileInfo.getAlgRemoteFilePath());

        UpdateResult result = mongoTemplate.updateFirst(
                new Query(Criteria.where("paperId").is(paperId)),
                update,
                PaperUpload.class
        );

        return result.getModifiedCount() > 0;
    }

    /**
     * 上传文件到两个服务器
     */
    private UploadResult uploadFiles(SftpConnectionPair connections, FileUploadInfo fileInfo,
                                     MultipartFile file) throws Exception {
        // 确保目录存在
        ensureDirectoryExists(connections.getMainSftp(), fileInfo.getRemoteFilePath());

        boolean mainSuccess = false;
        boolean algSuccess = false;

        try {
            // 上传到主服务器
            connections.getMainSftp().put(file.getInputStream(), fileInfo.getRemoteFilePath());
            mainSuccess = true;
            log.info("PDF文件上传到主服务器成功: {}", fileInfo.getRemoteFilePath());

            // 上传到算法服务器
            connections.getAlgSftp().put(file.getInputStream(), fileInfo.getAlgRemoteFilePath());
            algSuccess = true;
            log.info("PDF文件上传到算法服务器成功: {}", fileInfo.getAlgRemoteFilePath());

        } catch (Exception e) {
            log.error("文件上传失败", e);
            throw e;
        }

        return new UploadResult(mainSuccess, algSuccess);
    }

    /**
     * 确保目录存在
     */
    private void ensureDirectoryExists(ChannelSftp sftp, String filePath) throws SftpException {
        if (!SftpUtils.directoryExists(sftp, filePath)) {
            SftpUtils.mkdirDirs(filePath, sftp);
        }
    }

    /**
     * 处理已存在的文件
     */
    private void handleExistingFile(SftpConnectionPair connections, PaperUpload existingUpload,
                                    PdfAnalysis pdfAnalysis, String paperId, String questionId) {
        try {
            // 删除旧文件
            deleteOldFiles(connections, existingUpload, pdfAnalysis);

            // 清理相关数据
            cleanupRelatedData(pdfAnalysis, paperId, questionId);

        } catch (Exception e) {
            log.error("处理已存在文件失败", e);
        }
    }

    /**
     * 删除旧文件
     */
    private void deleteOldFiles(SftpConnectionPair connections, PaperUpload existingUpload,
                                PdfAnalysis pdfAnalysis) {
        try {
            // 删除PDF文件
            connections.getMainSftp().rm(existingUpload.getFilePath());
            connections.getAlgSftp().rm(existingUpload.getFilePath_alg());
            log.info("旧PDF文件删除成功");

            // 删除解析图片
            if (pdfAnalysis != null) {
                deleteAnalysisImages(connections.getMainSftp(), pdfAnalysis);
            }
        } catch (SftpException e) {
            log.warn("删除旧文件失败: {}", e.getMessage());
        }
    }

    /**
     * 删除解析生成的图片文件
     */
    private void deleteAnalysisImages(ChannelSftp sftp, PdfAnalysis pdfAnalysis) {
        try {
            // 删除主服务器上的图片目录
            if (StringUtils.isNotBlank(pdfAnalysis.getFilePath())) {
                SftpUtils.deleteDirectoryRecursively(sftp, pdfAnalysis.getFilePath());
                log.info("主服务器解析图片删除成功: {}", pdfAnalysis.getFilePath());
            }

            // 删除算法服务器上的图片目录
            if (StringUtils.isNotBlank(pdfAnalysis.getAlgFilePath())) {
                SftpUtils.deleteDirectoryRecursively(sftp, pdfAnalysis.getAlgFilePath());
                log.info("算法服务器解析图片删除成功: {}", pdfAnalysis.getAlgFilePath());
            }

        } catch (Exception e) {
            log.warn("删除解析图片失败: {}", e.getMessage());
            // 这里不抛出异常，因为图片删除失败不应该影响整个上传流程
        }
    }

    /**
     * 清理相关数据
     */
    private void cleanupRelatedData(PdfAnalysis pdfAnalysis, String paperId, String questionId) {
        try {
            if (pdfAnalysis != null) {
                // 删除课题下的质量评价信息
                pdfEditService.deletePdfEditByPaperIdAndQuestionId(paperId, questionId);
                pdfEditResultService.deletePdfEditResultByPaperIdAndQuestionId(paperId, questionId);

                // 删除图片解析相关记录
                mongoTemplate.remove(
                        new Query(Criteria.where("paperId").is(paperId)
                                .and("userId").is(pdfAnalysis.getUserId())),
                        "paper_mode_address"
                );

                // 更新PDF分析状态
                updatePdfAnalysisStatus(pdfAnalysis, questionId);

                log.info("清理相关数据成功, paperId: {}, questionId: {}", paperId, questionId);
            }
        } catch (Exception e) {
            log.error("清理相关数据失败, paperId: {}, questionId: {}", paperId, questionId, e);
            throw new RuntimeException("清理相关数据失败", e);
        }
    }

    /**
     * 更新PDF分析状态
     */
    private void updatePdfAnalysisStatus(PdfAnalysis pdfAnalysis, String questionId) {
        try {
            // 判断是否为替换操作：1、第一次上传  2、同一课题替换  3、不同课题替换
            if (StringUtils.isNotBlank(pdfAnalysis.getQuestionId())) {
                boolean isReplace = !questionId.equals(pdfAnalysis.getQuestionId());
                pdfAnalysis.setReplace(isReplace);
            }

            // 更新分析状态
            pdfAnalysis.setSuccess(null);        // 图片解析状态重置为失败
            pdfAnalysis.setAlgSuccess(null);     // 算法解析状态重置为失败
            pdfAnalysis.setQuestionId(questionId); // 更新课题ID
            pdfAnalysis.setStatus(1);             // 设置状态为处理中

            // 保存更新
            mongoTemplate.save(pdfAnalysis);

            log.info("PDF分析状态更新成功, paperId: {}, questionId: {}",
                    pdfAnalysis.getPaperId(), questionId);

        } catch (Exception e) {
            log.error("更新PDF分析状态失败", e);
            throw e;
        }
    }

    /**
     * 查找已存在的上传记录
     */
    private PaperUpload findExistingUpload(String paperId, long userId) {
        try {
            PaperUpload upload = mongoTemplate.findOne(
                    new Query(Criteria.where("paperId").is(paperId)
                            .and("userId").is(userId)),
                    PaperUpload.class
            );

            if (upload != null) {
                log.info("找到已存在的上传记录, paperId: {}, userId: {}", paperId, userId);
            }

            return upload;

        } catch (Exception e) {
            log.error("查找上传记录失败, paperId: {}, userId: {}", paperId, userId, e);
            throw new RuntimeException("查找上传记录失败", e);
        }
    }



    /**
     * 查找或创建PDF分析记录
     */
    private PdfAnalysis findOrCreatePdfAnalysis(String paperId, long userId, String questionId) {
        // 查找现有的PDF分析记录
        PdfAnalysis pdfAnalysis = mongoTemplate.findOne(
                new Query(Criteria.where("paperId").is(paperId)
                        .and("userId").is(userId)
                        .and("questionId").is(questionId)),
                PdfAnalysis.class
        );

        // 如果不存在，创建新的记录
        if (pdfAnalysis == null) {
            pdfAnalysis = createNewPdfAnalysis(paperId, userId, questionId);
            log.info("创建新的PDF分析记录, paperId: {}, questionId: {}", paperId, questionId);
        }

        return pdfAnalysis;
    }

    /**
     * 创建新的PDF分析记录
     */
    private PdfAnalysis createNewPdfAnalysis(String paperId, long userId, String questionId) {
        PdfAnalysis pdfAnalysis = new PdfAnalysis();
        pdfAnalysis.setUserId(userId);
        pdfAnalysis.setPaperId(paperId);
        pdfAnalysis.setQuestionId(questionId);
        pdfAnalysis.setSuccess(false);
        pdfAnalysis.setAlgSuccess(false);
        pdfAnalysis.setStatus(0); // 初始状态

        mongoTemplate.save(pdfAnalysis);
        return pdfAnalysis;
    }

    /**
     * 建立SFTP连接
     */
    private SftpConnectionPair establishSftpConnections() throws JSchException {
        // 主服务器连接
        ChannelSftp mainSftp = createSftpChannel(sftpHost, sftpPort, sftpUserName, sftpPassword);
        Session mainSession = mainSftp.getSession();

        // 算法服务器连接
        ChannelSftp algSftp = createSftpChannel(sftpHost_alg, sftpPort_alg, sftpUserName_alg, sftpPassword_alg);
        Session algSession = algSftp.getSession();

        return new SftpConnectionPair(mainSftp, mainSession, algSftp, algSession);
    }

    /**
     * 创建SFTP通道
     */
    private ChannelSftp createSftpChannel(String host, int port, String username, String password)
            throws JSchException {
        JSch jsch = new JSch();
        Session session = jsch.getSession(username, host, port);
        session.setPassword(password);

        Properties properties = new Properties();
        properties.put("StrictHostKeyChecking", "no");
        session.setConfig(properties);
        session.connect(Constants.SESSION_TIMEOUT);

        Channel channel = session.openChannel("sftp");
        channel.connect(Constants.CHANNEL_TIMEOUT);

        return (ChannelSftp) channel;
    }

    /**
     * 准备文件上传信息
     */
    private FileUploadInfo prepareFileInfo(PaperUploadRequest request) {
        MultipartFile file = request.getFile();
        String fileExt = FileUtils.getFileExt(file.getOriginalFilename());
        UUID fileNameUUID = UUID.randomUUID();
        String fileName = fileNameUUID + "." + fileExt;

        // 构建各种路径
        String remotePath = buildPath(sftpPath, "pdf");
        String remoteFilePath = buildPath(remotePath, fileName);
        String ipFilePath = buildPath(filePath, "pdf", fileName);
        String algRemoteFilePath = buildPath(sftpPath_alg, fileName);

        return FileUploadInfo.builder()
                .fileName(fileName)
                .fileNameUUID(fileNameUUID)
                .remotePath(remotePath)
                .remoteFilePath(remoteFilePath)
                .ipFilePath(ipFilePath)
                .algRemoteFilePath(algRemoteFilePath)
                .build();
    }

    /**
     * 构建路径
     */
    private String buildPath(String basePath, String... segments) {
        StringBuilder path = new StringBuilder(CommonUtil.removeSeparatorFromSuffix(basePath));
        for (String segment : segments) {
            path.append(Constants.PAD_LEFT_SLASH).append(segment);
        }
        return path.toString();
    }

}

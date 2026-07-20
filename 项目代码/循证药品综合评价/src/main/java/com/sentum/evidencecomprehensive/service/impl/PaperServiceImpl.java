package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateTime;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.io.IoUtil;
import cn.hutool.core.lang.Snowflake;
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
import com.sentum.evidencecomprehensive.domain.enums.PaperEditEconomyEnum;
import com.sentum.evidencecomprehensive.domain.enums.PaperEditMetaEnum;
import com.sentum.evidencecomprehensive.domain.enums.PaperEditRctEnum;
import com.sentum.evidencecomprehensive.domain.enums.PredictResultEnum;
import com.sentum.evidencecomprehensive.domain.dto.*;
import com.sentum.evidencecomprehensive.domain.es.DrugAndIndicationIndex;
import com.sentum.evidencecomprehensive.domain.es.PaperIndex;
import com.sentum.evidencecomprehensive.domain.mongo.*;
import com.sentum.evidencecomprehensive.domain.mongo.upload.PaperUpload;
import com.sentum.evidencecomprehensive.domain.mongo.upload.PdfAnalysis;
import com.sentum.evidencecomprehensive.domain.vo.*;
import com.sentum.evidencecomprehensive.domain.vo.evaluate.*;
import com.sentum.evidencecomprehensive.domain.vo.req.*;
import com.sentum.evidencecomprehensive.domain.vo.resp.PaperResponse;
import com.sentum.evidencecomprehensive.event.PictureAnalysisEvent;
import com.sentum.evidencecomprehensive.event.bo.PictureAnalysisBo;
import com.sentum.evidencecomprehensive.domain.entity.paper.PaperInfo;
import com.sentum.evidencecomprehensive.domain.entity.paper.PdfEdit;
import com.sentum.evidencecomprehensive.domain.entity.paper.PdfEditResult;
import com.sentum.evidencecomprehensive.domain.dto.ExcludeReasonDTO;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.domain.vo.JournalDivision;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.service.*;
import com.sentum.evidencecomprehensive.utils.*;
import com.sentum.evidencecomprehensive.utils.operateyl.SftpUtils;
import lombok.SneakyThrows;
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

import javax.imageio.ImageIO;
import javax.servlet.ServletOutputStream;
import javax.servlet.http.HttpServletResponse;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.time.Instant;
import java.util.*;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
public class PaperServiceImpl implements PaperService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private ApplicationEventPublisher applicationEventPublisher;
    @Autowired
    private PdfEditService pdfEditService;
    @Autowired
    private PaperInfoServiceImpl paperInfoService;
    @Autowired
    private PdfEditResultService pdfEditResultService;
    @Autowired
    private FineScreenFeign fineScreenFeign;
    @Autowired
    private RetrievalService retrievalService;
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
    @Value("${file.server.paper.edit-url}")
    private String paperEditUrl;
    @Value("${localPath.pdf.to.image}")
    private String pdfToImagePath;

    private final ExecutorService executorService = Executors.newFixedThreadPool(10);

    @Override
    public JSONObject typeNumList(PaperInitialRequest paperInitialRequest, long userId) {
        String id = paperInitialRequest.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }

        PaperPICOConditionDTO paperPICOConditionDTO = paperInitialRequest.getPaperPICOConditionDTO();

        PaperModelConditionDTO paperModelConditionDTO = paperInitialRequest.getPaperModelConditionDTO();
        if (Objects.nonNull(paperPICOConditionDTO) || Objects.nonNull(paperModelConditionDTO)) {
            ConditionLiteratureAlter conditionLiteratureAlter = new ConditionLiteratureAlter();
            if (Objects.nonNull(paperPICOConditionDTO)) {
                BeanUtils.copyProperties(paperPICOConditionDTO, conditionLiteratureAlter);
                paperPICOConditionDTO.setUpdateTime(Instant.now().toEpochMilli());
                condition.setConditionLiteratureAlter(conditionLiteratureAlter);
                condition.setGuideWipeDiseases(null);
                condition.setLiteratureWipeDiseases(null);
                // 数据补全（商品名、五级中英文）
                retrievalService.dataCompletion(condition);
                condition.setPaperPICOConditionDTO(paperPICOConditionDTO);
            }
            
            if (Objects.nonNull(paperModelConditionDTO)) {
                BeanUtils.copyProperties(paperModelConditionDTO, conditionLiteratureAlter);
                paperModelConditionDTO.setUpdateTime(Instant.now().toEpochMilli());
                condition.setConditionLiteratureAlter(conditionLiteratureAlter);
                condition.setPaperModelConditionDTO(paperModelConditionDTO);
                condition.setGuideWipeDiseases(null);
                condition.setLiteratureWipeDiseases(null);
            }
            mongoTemplate.findAndReplace(Query.query(Criteria.where("id").is(condition.getId())), condition);
        }

        List<Integer> typeList = Arrays.asList(0, 1, 2, 14, 3, 4, 5, 6, 7, 8, 11, 12, 9, 10, 13);
        List<String> nameList = Arrays.asList("系统综述/Meta分析", "传统综述", "随机对照试验", "临床试验", "队列研究", "病例对照研究", "横断面研究", "病例系列", "病例报告",
                "专家意见和评价", "指南/共识", "经济学评价", "动物实验", "体外实验", "其他");

        List<Integer> studyType = condition.getStudyType();
        List<String> studyStringType = new ArrayList<>();
        for (Integer integer : studyType) {
            studyStringType.add(String.valueOf(integer));
        }

        BoolQueryBuilder paperQuery = new BoolQueryBuilder();
        // 对于残缺文献 需要有 title
        paperQuery.must().add(QueryBuilders.existsQuery("title"));
        // 年份
        String literatureStartYear = condition.getLiteratureStartYear();
        String literatureEndYear = condition.getLiteratureEndYear();
        RangeQueryBuilder ysarRangeQueryBuilder = QueryBuilders.rangeQuery("year");
        if (StrUtil.isNotBlank(literatureStartYear)) {
            ysarRangeQueryBuilder.gte(literatureStartYear);
        }
        if (StrUtil.isNotBlank(literatureEndYear)) {
            ysarRangeQueryBuilder.lte(literatureEndYear);
        }
        paperQuery.must().add(ysarRangeQueryBuilder);

        // 研究类型
        BoolQueryBuilder studyTypeBoolQueryBuilder = new BoolQueryBuilder();
        if (CollUtil.isNotEmpty(studyType)) {
            for (Integer type : studyType) {
                if (type == 14) {
                    studyTypeBoolQueryBuilder.should().add(QueryBuilders.termQuery("type", 7));
                } else {
                    studyTypeBoolQueryBuilder.should().add(QueryBuilders.termQuery("lastNewType", type));
                }
            }
        } else {
            studyTypeBoolQueryBuilder.should().add(QueryBuilders.termsQuery("lastNewType", Constants.PAPER_LIST_LITERATURE_TYPE));
            studyTypeBoolQueryBuilder.should().add(QueryBuilders.matchQuery("type", 7));
        }
        paperQuery.must().add(studyTypeBoolQueryBuilder);

        boolean shouldData = false;
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
                }
            }
            paperQuery.must().add(boolQueryBuilder);
        }

        List<String> drugSynonym = handleDrugToSynonym(condition.getDrugs());
        List<String> diseaseSynonym = handleDiseaseToSynonym(condition.getDiseases());
        // 针对纳入排除的总数
        List<String> includeExcludeIds = new ArrayList<>();
        NativeSearchQuery nativeSearchQuery;

        String operateType = paperInitialRequest.getType();
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
            selectSearchPattern(condition, paperQuery);
            nativeSearchQuery = new NativeSearchQuery(paperQuery);
        }

        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));

        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("type").field("lastNewType").size(15);
        TermsAggregationBuilder aggregationBuilder2 = AggregationBuilders.terms("originalType").field("type").size(15);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        nativeSearchQuery.addAggregation(aggregationBuilder2);

        SearchHits<PaperIndex> search = null;
        long totalHits = 0L;
        Aggregations aggregations = null;
        if (shouldData) {
            search = elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class);
            totalHits = search.getTotalHits();
            aggregations = search.getAggregations();
        }
        
        // 返回结果
        JSONObject result = new JSONObject();

        Map<Integer, Long> numMap = new HashMap<>();
        JSONArray types = new JSONArray();
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

            if (studyStringType.contains(String.valueOf(type))) {
                if (numMap.containsKey(type)) {
                    count = numMap.get(type);
                }
            }
            String name = nameList.get(i);
            inner.put("value", name + "(" + count + ")");
            inner.put("type", type);
            types.add(inner);
        }
        JSONObject inner = new JSONObject();
        inner.put("value", "总库(" + totalHits + ")");
        inner.put("type", 27);
        types.add(0, inner);
        result.put("type", types);
        echoData(id, result);
        return result;
    }

    @Override
    public PageVo<PaperResponse> list(PaperSearchRequest paperSearchRequest, Long userId) {
        String id = paperSearchRequest.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }
        BoolQueryBuilder paperQuery = new BoolQueryBuilder();
        // 对于残缺文献 需要有 title
        paperQuery.must().add(QueryBuilders.existsQuery("title"));
        //用户选择文献类型
        Integer studyType = paperSearchRequest.getStudyType();
        if (studyType != 27) {
            if (studyType == 14) {
                paperQuery.must().add(QueryBuilders.termQuery("type", 7));
            } else {
                paperQuery.must().add(QueryBuilders.termQuery("lastNewType", studyType));
            }
        } else {
            BoolQueryBuilder studyTypeBool = new BoolQueryBuilder();

            List<Integer> defaultStudyType = condition.getStudyType();
            if (CollUtil.isNotEmpty(defaultStudyType)) {
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
        //语言类型
        Integer language = paperSearchRequest.getLanguage();
        if (language != 0) {
            if (language == 1) {
                //中文
                paperQuery.must().add(QueryBuilders.termQuery("language", "zh"));
            } else {
                //英文
                paperQuery.must().add(QueryBuilders.termQuery("language", "en"));
            }
        }

        boolean shouldData = false;
        List<String> zhJournal = condition.getZhJournal();
        List<String> enJournal = condition.getEnJournal();
        //期刊级别
        List<JournalDivision> journalLevel = paperSearchRequest.getJournalLevel();
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
        List<Integer> quality = paperSearchRequest.getQuality();
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
            if (CollUtil.isNotEmpty(ids1) || CollUtil.isNotEmpty(ids2) || CollUtil.isNotEmpty(ids3)) {
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
                if (CollUtil.isNotEmpty(inIds)) {
                    qualityBool.should().add(QueryBuilders.idsQuery().addIds(inIds.toArray(new String[0])));
                }
                if (CollUtil.isNotEmpty(outIds)) {
                    qualityBool.mustNot().add(QueryBuilders.idsQuery().addIds(outIds.toArray(new String[0])));
                }
            }
            qualityBool.should().add(QueryBuilders.termsQuery("quality", realQuality));
            paperQuery.must().add(qualityBool);
        }

        String startSearchYear;
        String endSearchYear;
        String literatureStartYear = condition.getLiteratureStartYear();
        String literatureEndYear = condition.getLiteratureEndYear();
        //发表年份
        Integer startYear = paperSearchRequest.getStartYear();
        if (startYear != null) {
            if (startYear >= Integer.parseInt(literatureStartYear) && startYear <= Integer.parseInt(literatureEndYear)) {
                startSearchYear = startYear.toString();
            } else {
                startSearchYear = literatureStartYear;
            }
        } else {
            startSearchYear = literatureStartYear;
        }
        Integer endYear = paperSearchRequest.getEndYear();
        if (endYear != null) {
            if (endYear >= Integer.parseInt(literatureStartYear) && endYear <= Integer.parseInt(literatureEndYear)) {
                endSearchYear = endYear.toString();
            } else {
                endSearchYear = literatureEndYear;
            }
        } else {
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
        paperQuery.must().add(QueryBuilders.rangeQuery("year").gte(startSearchYear).lte(endSearchYear));

        //二次搜索条
        String search = paperSearchRequest.getSearch();
        if (StringUtils.isNotBlank(search)) {
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(search, "title", "summary", "author", "year", "journal");
            multiMatchQueryBuilder.operator(Operator.AND);
            multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
//            multiMatchQueryBuilder.slop(0);
//            multiMatchQueryBuilder.field("title", 24F);
            paperQuery.must().add(multiMatchQueryBuilder);
        }
        //排序-分页
        Integer sortType = paperSearchRequest.getSortType();
        Integer sortDirection = paperSearchRequest.getSortDirection();
        PageRequest pageRequest = PageRequest.of(paperSearchRequest.getPageNum() - 1, paperSearchRequest.getPageSize());
        if (sortType == 1) {
            //影响因子
            Sort.Direction direction = Sort.Direction.ASC;
            if (sortDirection == 0) {
                direction = Sort.Direction.DESC;
            }
            pageRequest = PageRequest.of(paperSearchRequest.getPageNum() - 1, paperSearchRequest.getPageSize(), Sort.by(direction, "jcr"));
        } else if (sortType == 2) {
            //年份
            Sort.Direction direction = Sort.Direction.ASC;
            if (sortDirection == 0) {
                direction = Sort.Direction.DESC;
            }
            pageRequest = PageRequest.of(paperSearchRequest.getPageNum() - 1, paperSearchRequest.getPageSize(), Sort.by(direction, "year"));
        }

        List<String> drugSynonym = handleDrugToSynonym(condition.getDrugs());
        List<String> diseaseSynonym = handleDiseaseToSynonym(condition.getDiseases());

        //判断文献所属
        Integer operateType = paperSearchRequest.getOperateType();
        if (operateType == 1) {
            //纳入文献
            List<PaperIncludeOrExclude> includeList = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);
            List<String> ids = new ArrayList<>();
            includeList.forEach(include -> ids.add(include.getPaperId()));
            paperQuery.must().add(QueryBuilders.idsQuery().addIds(ids.toArray(new String[0])));
        } else if (operateType == 2) {
            //排除文献
            List<PaperIncludeOrExclude> excludeList = mongoTemplate.find(new Query(Criteria.where("userId").is(userId).and("conditionId").is(id).and("status").is(2)), PaperIncludeOrExclude.class);
            List<String> ids = new ArrayList<>();
            excludeList.forEach(exclude -> ids.add(exclude.getPaperId()));
            paperQuery.must().add(QueryBuilders.idsQuery().addIds(ids.toArray(new String[0])));
        } else {
            selectSearchPattern(condition, paperQuery);
        }
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
            filterFunctionBuilders[2] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(languageScriptFunction);
            filterFunctionBuilders[3] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(lastNewTypeScriptFunction);

            FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(paperQuery, filterFunctionBuilders);
            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.MULTIPLY);
            functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);

   
            nativeSearchQuery = new NativeSearchQueryBuilder()
                    .withQuery(functionScoreQueryBuilder)
                    .withSort(SortBuilders.scoreSort().order(SortOrder.DESC))
                    .withSourceFilter(new FetchSourceFilter(new String[]{}, null))
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

        List<PaperResponse> list = new ArrayList<>();
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
            list.addAll(processPapers(searchHits, id, userId, stopWord, condition, search, studyType));
        }
        int pages = (int) (totalHits % paperSearchRequest.getPageSize() == 0 ? totalHits / paperSearchRequest.getPageSize() : totalHits / paperSearchRequest.getPageSize() + 1);
        PageVo<PaperResponse> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(paperSearchRequest.getPageSize());
        page.setPageNum(paperSearchRequest.getPageNum());
        return page;
    }

    private String buildScriptByDrugAndDisease(List<String> drugSynonym, List<String> diseaseSynonym) {
        StringBuilder result = new StringBuilder();
        result.append("def disease = false; def drug = false;");

        if (CollUtil.isNotEmpty(diseaseSynonym)) {
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

        if (CollUtil.isNotEmpty(drugSynonym)) {
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

        result.append("if (disease == true && drug == true) {return 1000;} else {return 0;} ");
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



    public List<PaperResponse> processPapers(SearchHits<PaperIndex> searchHits, String id, Long userId, List<String> stopWord, Condition condition, String search, Integer studyType) {
        // 使用流将每条数据包装为 CompletableFuture
        List<CompletableFuture<PaperResponse>> futures = searchHits.stream()
                .map(searchHit -> CompletableFuture.supplyAsync(() -> processPaper(searchHit, id, userId, stopWord, condition, search, studyType), executorService))
                .collect(Collectors.toList());

        // 等待所有任务完成并收集结果
        return futures.stream()
                .map(CompletableFuture::join) // 阻塞等待任务完成
                .filter(Objects::nonNull)    // 过滤掉 null 结果
                .collect(Collectors.toList());
    }

    private PaperResponse processPaper(SearchHit<PaperIndex> searchHit, String id, Long userId, List<String> stopWord, Condition condition, String search, Integer studyType) {
        PaperIndex content = searchHit.getContent();
        String contentId = content.getId();
        //------------本地环境暂时使用正式环境的mongo进行文献的查询----------
        MongoLiterature mongoLiterature = fineScreenFeign.paper(contentId);
//        MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findById(contentId, MongoLiterature.class, "mongo_literature_" + Math.abs(contentId.hashCode()) % 10);
        if (mongoLiterature != null) {
            //高亮显示情况
            List<String> titleList = searchHit.getHighlightField("title");
            List<String> summaryList = searchHit.getHighlightField("summary");
            StringBuilder titleBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(titleList)) {
                titleList.forEach(titleBuilder::append);
            }
            StringBuilder summaryBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(summaryList)) {
                summaryList.forEach(summaryBuilder::append);
            }
            mongoLiterature.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? mongoLiterature.getTitle() : highLight(HighLightUtils.repairContent(titleBuilder.toString(), content.getTitle(), stopWord), mongoLiterature.getTitle(), condition, search));
            mongoLiterature.setSummary(StringUtils.isBlank(summaryBuilder.toString()) ? mongoLiterature.getSummary() : highLight(HighLightUtils.repairContent(summaryBuilder.toString(), content.getSummary(), stopWord), mongoLiterature.getSummary(), condition, search));

            PaperResponse paperResponse = FormatUtil.formatPaper(mongoLiterature);
            PdfAnalysis pdfAnalysis;
            if (studyType != 27) {
                pdfAnalysis = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(mongoLiterature.getId())
                        .and("questionId").is(id)
                        .and("userId").is(userId)
                        .and("paperType").is(String.valueOf(studyType))), PdfAnalysis.class);
            } else {
                pdfAnalysis = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(mongoLiterature.getId())
                        .and("questionId").is(id)), PdfAnalysis.class);
            }

            if (Objects.nonNull(pdfAnalysis) && Objects.nonNull(pdfAnalysis.getSuccess()) && pdfAnalysis.getSuccess() && StrUtil.isNotBlank(pdfAnalysis.getOnePicUrl())) {
                paperResponse.setPdfToPicVo(new PdfToPicVo(pdfAnalysis.getImagesCount(), pdfAnalysis.getOnePicUrl()));
            }
            if (studyType != 27) {
                // 质量评价结果
                PdfEditResult paperEditResult = pdfEditResultService.getPaperEditResultPaperIdAndQuestionId(mongoLiterature.getId(), id, String.valueOf(studyType));
                if (Objects.nonNull(paperEditResult)) {
                    String qualityMeta = paperEditResult.getQualityMeta();
                    if (StrUtil.isNotBlank(qualityMeta)) {
                        paperResponse.setQualityMeta(qualityMeta);
                    }
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

    private void selectSearchPattern(Condition condition, BoolQueryBuilder paperQuery) {
        PaperPICOConditionDTO paperPICOCondition = condition.getPaperPICOConditionDTO();
        PaperModelConditionDTO paperModelCondition = condition.getPaperModelConditionDTO();

        ConditionLiteratureAlter conditionLiteratureAlter = condition.getConditionLiteratureAlter();
        // 证明没有使用过高级检索 所以直接使用 condition 检索即可
        if (Objects.isNull(paperModelCondition)) {
            if (Objects.nonNull(conditionLiteratureAlter)) {
                paperQuery.must().add(QueryUtils.createPaperQuery(condition, 1));
                paperQuery.filter().add(QueryBuilders.termsQuery("isIncomplete", "0", "2"));
            } else {
                paperQuery.must().add(QueryUtils.createPaperQueryNew(condition, 1));
                paperQuery.filter().add(QueryBuilders.termsQuery("isIncomplete", "0", "2"));
            }
        } else {
            // 如果使用过 mode 高级检索，没有还是用过 pico 检索 就直接 model 检索
            if (Objects.isNull(paperPICOCondition)) {
                // 高级检索
                BoolQueryBuilder paperQueryBool = useMode(paperModelCondition.getMode(), paperModelCondition.getZhEnExtension(), paperModelCondition.getSynonymExtension());
                paperQuery.must().add(paperQueryBool);
            } else {
                // 都使用过需要判断一下 那个是最新的
                Long picoUpdateTime = paperPICOCondition.getUpdateTime();
                Long modelUpdateTime = paperModelCondition.getUpdateTime();
                if (picoUpdateTime > modelUpdateTime) {
                    if (Objects.nonNull(conditionLiteratureAlter)) {
                        paperQuery.must().add(QueryUtils.createPaperQueryNew(condition, 1));
                        paperQuery.filter().add(QueryBuilders.termsQuery("isIncomplete", "0", "2"));
                    } else {
                        paperQuery.must().add(QueryUtils.createPaperQueryNew(condition, 1));
                        paperQuery.filter().add(QueryBuilders.termsQuery("isIncomplete", "0", "2"));
                    }
                } else {
                    // 高级检索
                    BoolQueryBuilder paperQueryBool = useMode(paperModelCondition.getMode(), paperModelCondition.getZhEnExtension(), paperModelCondition.getSynonymExtension());
                    paperQuery.must().add(paperQueryBool);
                }
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
                    if (CollUtil.isNotEmpty(synonymSet)) {
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
                        if (CollUtil.isNotEmpty(zhEnsynonymSet)) {
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
        if (CollUtil.isNotEmpty(assembleTerms)) {
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
        String formula = FormulaFeignUtil.formula(StrUtil.replace(newMode, "[全部]", ""), 1);
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

    @Override
    public Boolean operate(OperateRequest OperateRequest, Long userId) {
        String conditionId = OperateRequest.getId();
        List<String> ids = OperateRequest.getIds();
        //操作的命令，1-纳入；2-取消纳入；3-排除；4-取消排除；5-收藏；6-取消收藏
        Integer operate = OperateRequest.getOperate();
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
                            update.set("type", 1);
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, PaperIncludeOrExclude.class);
                            includeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    } else {
                        includeList.add(new PaperIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 1, 1, userId, System.currentTimeMillis()));
                    }
                }
                if (!includeList.isEmpty()) {
                    Collection<PaperIncludeOrExclude> insert = mongoTemplate.insert(includeList, PaperIncludeOrExclude.class);
                    if (CollUtil.isNotEmpty(insert)) {
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
                    } else {
                        excludeList.add(new PaperIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 2, 0, userId, System.currentTimeMillis()));
                    }
                }
                if (CollUtil.isNotEmpty(excludeList)) {
                    Collection<PaperIncludeOrExclude> insert = mongoTemplate.insert(excludeList, PaperIncludeOrExclude.class);
                    if (CollUtil.isNotEmpty(insert)) {
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
                    if (!exists) {
                        collectList.add(new PaperCollect(UUID.randomUUID().toString(), conditionId, id, userId, System.currentTimeMillis()));
                    }
                }
                if (!collectList.isEmpty()) {
                    Collection<PaperCollect> insert = mongoTemplate.insert(collectList, PaperCollect.class);
                    if (CollUtil.isNotEmpty(insert)) {
                        flag = true;
                    }
                }
                break;
            default:
                break;
        }
        return flag;
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
        } else {
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

    /**
     * 0 上传成功 1 上传失败 2 有人上传
     *
     * @param paperUploadRequest 上传实体
     * @param userId             用户id
     */
    @SneakyThrows
    @Override
    public int uploadPdf(PaperUploadRequest paperUploadRequest, Long userId) {
        Date begin = new Date();
        // 文献id
        String paperId = paperUploadRequest.getId();
        // 课题id
        String questionId = paperUploadRequest.getQuestionId();
        String paperType = paperUploadRequest.getType();
        if (StrUtil.isNotBlank(paperId)) {
            // 文件
            MultipartFile file = paperUploadRequest.getFile();

            String fileExt = FileUtils.getFileExt(file.getOriginalFilename());
            // 放入服务器中的名字
            UUID fileNameUUID = UUID.randomUUID();
            String fileName = fileNameUUID + "." + fileExt;

            // 上传 pdf 存放目录
            // http://192.168.20.252:2024/test_upload/
            //   /data/evimed_v4/flutter/test_upload/

            //    /data/evimed_v4/flutter/test_upload/pdf/
            String remotePath = CommonUtil.removeSeparatorFromSuffix(sftpPath).concat(Constants.PAD_LEFT_SLASH).concat("pdf").concat(Constants.PAD_LEFT_SLASH);
            // 上传 pdf 文件绝对路径   //     /data/evimed_v4/flutter/test_upload/pdf/xxx.pdf
            String remoteFilePath = CommonUtil.removeSeparatorFromSuffix(remotePath).concat(Constants.PAD_LEFT_SLASH).concat(fileName);
            // 上传 pdf 直接可以访问的地址   // http://192.168.20.252:2024/test_upload/pdf/xxx.pdf
            String ipFilePath = CommonUtil.removeSeparatorFromSuffix(filePath).concat(Constants.PAD_LEFT_SLASH).concat("pdf").concat(Constants.PAD_LEFT_SLASH).concat(fileName);

            // 算法服务器上 pdf 存放路径
            String algRemoteFilePath = CommonUtil.removeSeparatorFromSuffix(sftpPath_alg).concat(Constants.PAD_LEFT_SLASH).concat(fileName);

            boolean flag = false;
            boolean picAnalysisSuccess = false;
            boolean algAnalysisSuccess = false;

            // pdf 上传需要的 jsch
            Session jschSession = null;
            // pdf 上传需要需要解析 pdf的j sch
            Session jschSession_alg = null;
            try {
                // 上传 pdf sftp 连接
                JSch jsch = new JSch();
                jschSession = jsch.getSession(sftpUserName, sftpHost, sftpPort);
                jschSession.setPassword(sftpPassword);
                Properties properties = new Properties();
                properties.put("StrictHostKeyChecking", "no");
                jschSession.setConfig(properties);
                jschSession.connect(Constants.SESSION_TIMEOUT);
                Channel sftp = jschSession.openChannel("sftp");
                sftp.connect(Constants.CHANNEL_TIMEOUT);
                ChannelSftp channelSftp = (ChannelSftp) sftp;

                // 上传 pdf 到算法服务器 sftp 连接
                JSch jsch_alg = new JSch();
                jschSession_alg = jsch_alg.getSession(sftpUserName_alg, sftpHost_alg, sftpPort_alg);
                jschSession_alg.setPassword(sftpPassword_alg);
                Properties properties_alg = new Properties();
                properties_alg.put("StrictHostKeyChecking", "no");
                jschSession_alg.setConfig(properties_alg);
                jschSession_alg.connect(Constants.SESSION_TIMEOUT);
                Channel sftp_alg = jschSession_alg.openChannel("sftp");
                sftp_alg.connect(Constants.CHANNEL_TIMEOUT);
                ChannelSftp channelSftp_alg = (ChannelSftp) sftp_alg;

                // pdf 上传实体类 
                PaperUpload upload = mongoTemplate.findOne(
                        new Query(Criteria.where("paperId").is(paperId)
                                .and("userId").is(userId)
                                .and("paperType").is(paperType)), PaperUpload.class);
                // pdf 分析实体类
                PdfAnalysis pdfAnalysis = mongoTemplate.findOne(
                        new Query(Criteria.where("paperId").is(paperId)
                                .and("userId").is(userId)
                                .and("questionId").is(questionId)
                                .and("paperType").is(paperType)), PdfAnalysis.class);

                if (upload != null) {
                    try {
                        // 删除原来上传过的文件
                        channelSftp.rm(upload.getFilePath());
                        channelSftp_alg.rm(upload.getFilePath_alg());
                        log.info("远程 pdf 删除成功，remoteFilePath is {}", remoteFilePath);
                    } catch (SftpException e) {
                        log.error(e.getMessage(), e);
                    } finally {
                        // 此操作需要删除之前 pdf 上传成功之后，解析成功的图片
                        if (Objects.nonNull(pdfAnalysis)) {
                            try {
                                if (StrUtil.isNotBlank(pdfAnalysis.getFilePath())) {
                                    SftpUtils.deleteDirectoryRecursively(channelSftp, pdfAnalysis.getFilePath());
                                }
                                if (StrUtil.isNotBlank(pdfAnalysis.getAlgFilePath())) {
                                    SftpUtils.deleteDirectoryRecursively(channelSftp, pdfAnalysis.getAlgFilePath());
                                }
                                log.info("上一版本解析成功的图片删除成功！！！");
                            } catch (Exception e) {
                                log.info("上一版本解析成功的图片删除失败！！！");
                                log.error(e.getMessage(), e);
                            } finally {
                                // 需要将上一版本课题下的质量评价信息删除
                                pdfEditService.deletePdfEditByPaperIdAndQuestionId(paperId, questionId);
                                pdfEditResultService.deletePdfEditResultByPaperIdAndQuestionId(paperId, questionId);
                                // 删除图片解析实体类
//                                mongoTemplate.remove(new Query(Criteria.where("paperId").and("userId").is(userId)), PdfAnalysis.class);
                                mongoTemplate.remove(
                                        new Query(Criteria.where("paperId").is(paperId)
                                                .and("userId").is(userId)), "paper_mode_address");

                                // 1、第一次上传  2、同一课题替换 3、不同课题替换
                                if (StrUtil.isNotBlank(pdfAnalysis.getQuestionId())) {
                                    pdfAnalysis.setReplace(!questionId.equals(pdfAnalysis.getQuestionId()));
                                }
                                // 在被其它课题替换过程中 目前上传和算法解析都是失败的
                                pdfAnalysis.setSuccess(null);
                                pdfAnalysis.setAlgSuccess(null);
                                pdfAnalysis.setQuestionId(questionId);
                                pdfAnalysis.setStatus(1);
                                mongoTemplate.save(pdfAnalysis);
                            }
                        } else {
                            PdfAnalysis noExists = new PdfAnalysis();
                            noExists.setUserId(userId);
                            noExists.setPaperId(paperId);
                            noExists.setQuestionId(questionId);
                            noExists.setSuccess(null);
                            mongoTemplate.save(noExists);
                        }
                    }
                    flag = true;
                }

//                // 这里目前有个 bug 就是服务和文献需要上传的服务器不是同一个时 需要手动创建pdf上传目录  待解决
//                if (!FileUtil.exist(remoteFilePath)) {
//                    FileUtil.mkParentDirs(remoteFilePath);
//                }

                boolean exists = SftpUtils.directoryExists(channelSftp, remotePath);
                if (!exists) {
                    SftpUtils.mkdirDirs(remotePath, channelSftp);
                }

                // pdf 文件上传
                channelSftp.put(file.getInputStream(), remoteFilePath);
                picAnalysisSuccess = true;
                channelSftp.exit();
                log.info("新 pdf 文件上传成功，路径 remoteFilePath is {}", remoteFilePath);

                // 同时传输一份pdf到大哥服务器上(算法服务器)
                channelSftp_alg.put(file.getInputStream(), algRemoteFilePath);
                algAnalysisSuccess = true;
                channelSftp_alg.exit();
                log.info("新 pdf 文件上传成功，路径 algRemoteFilePath is {}", algRemoteFilePath);
            } catch (JSchException | SftpException e) {
                log.error(e.getMessage(), e);
            } finally {
                if (jschSession != null) {
                    try {
                        jschSession.disconnect();
                    } catch (Exception e) {
                        log.warn(e.getMessage(), e);
                    }
                }
                if (jschSession_alg != null) {
                    try {
                        jschSession_alg.disconnect();
                    } catch (Exception e) {
                        log.warn(e.getMessage(), e);
                    }
                }
            }
            log.info("上传文献 id {}, pdf 上传完成花费时间{}， pdf 文件上传完成！", paperId, new Date().getTime() - begin.getTime());


            if (flag) {
                Update update = new Update();
                update.set("filePath", remoteFilePath);
                update.set("path", remotePath);
                update.set("fileUrl", ipFilePath);
                update.set("timeStamp", System.currentTimeMillis());
                update.set("userId", userId);
                update.set("success", true);
                update.set("filePath_alg", algRemoteFilePath);
                update.set("paperType", paperUploadRequest.getType());
                UpdateResult updateResult = mongoTemplate.updateFirst(new Query(Criteria.where("paperId").is(paperId)), update, PaperUpload.class);

                try {
                    // 进行pdf转图片event
                    if (picAnalysisSuccess) {
                        PictureAnalysisBo pictureAnalysisBo = new PictureAnalysisBo(paperId,
                                questionId, userId, remotePath, fileNameUUID.toString(),
                                "png", algRemoteFilePath, "", paperUploadRequest.getType(), algAnalysisSuccess);
                        applicationEventPublisher.publishEvent(new PictureAnalysisEvent(this, pictureAnalysisBo));
                    }
                    return updateResult.getModifiedCount() > 0 ? 0 : 1;
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            } else {
                String id = new Snowflake().nextIdStr();
                PaperUpload paperUpload = new PaperUpload(id, paperId, userId,
                        true, remoteFilePath, remotePath,
                        ipFilePath, System.currentTimeMillis(), algRemoteFilePath, paperUploadRequest.getType());
                mongoTemplate.save(paperUpload);

                try {
                    // 进行pdf转图片event
                    if (picAnalysisSuccess) {
                        PictureAnalysisBo pictureAnalysisBo = new PictureAnalysisBo(paperId, questionId, userId,
                                remotePath, fileNameUUID.toString(), "png",
                                algRemoteFilePath, "", paperUploadRequest.getType(), algAnalysisSuccess);
                        applicationEventPublisher.publishEvent(new PictureAnalysisEvent(this, pictureAnalysisBo));
                    }
                    return 0;
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            }
        }
        return 1;
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
            if (StrUtil.isNotBlank(pdfAnalysis.getFilePath())) {
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
                    log.error("转换图片时发生错误{}", e.getMessage());
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


    private List<JSONObject> getReferencePrice(List<Drug> drugs, List<InterventionAndOutcome> outcomes, String search) {
        List<String> drugNames = new ArrayList<>();
        if (Objects.nonNull(drugs) && CollUtil.isNotEmpty(drugs)) {
            drugs.forEach(drug -> {
                if (StrUtil.isNotBlank(drug.getWord())) drugNames.add(drug.getWord());
                if (StrUtil.isNotBlank(drug.getEnWord())) drugNames.add(drug.getEnWord());
                if (StrUtil.isNotBlank(drug.getZhWord())) drugNames.add(drug.getZhWord());
                if (CollUtil.isNotEmpty(drug.getEnSynonym())) {
                    drug.getEnSynonym().forEach(wordStatus -> drugNames.add(wordStatus.getName()));
                }
                if (CollUtil.isNotEmpty(drug.getZhSynonym())) {
                    drug.getZhSynonym().forEach(wordStatus -> drugNames.add(wordStatus.getName()));
                }
            });
        }

        if (Objects.nonNull(outcomes) && CollUtil.isNotEmpty(outcomes)) {
            outcomes.forEach(interventionAndOutcome -> {
                if (StrUtil.isNotBlank(interventionAndOutcome.getWord()))
                    drugNames.add(interventionAndOutcome.getWord());
                if (StrUtil.isNotBlank(interventionAndOutcome.getEnWord()))
                    drugNames.add(interventionAndOutcome.getEnWord());
                if (StrUtil.isNotBlank(interventionAndOutcome.getZhWord()))
                    drugNames.add(interventionAndOutcome.getZhWord());
                if (CollUtil.isNotEmpty(interventionAndOutcome.getEnSynonym())) {
                    interventionAndOutcome.getEnSynonym().forEach(wordStatus -> drugNames.add(wordStatus.getName()));
                }
                if (CollUtil.isNotEmpty(interventionAndOutcome.getZhSynonym())) {
                    interventionAndOutcome.getZhSynonym().forEach(wordStatus -> drugNames.add(wordStatus.getName()));
                }
            });
        }

        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        List<JSONObject> result = new ArrayList<>();
        if (CollUtil.isNotEmpty(drugNames)) {
            BoolQueryBuilder drugBooleanQueryBuilder = new BoolQueryBuilder();
            for (String drugName : drugNames) {
//                    BoolQueryBuilder temp = new BoolQueryBuilder();
                drugBooleanQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", drugName));
                drugBooleanQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", drugName));
                drugBooleanQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", drugName));
                drugBooleanQueryBuilder.should().add(QueryBuilders.matchQuery("drugName.keyword", drugName));
            }
            boolQueryBuilder.must().add(drugBooleanQueryBuilder);
            if (StrUtil.isNotBlank(search)) {
                MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(search, "zhDrugName", "dosageForm", "specifications", "manufacturer");
                multiMatchQueryBuilder.operator(Operator.AND);
//                multiMatchQueryBuilder.slop(0);
                multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                boolQueryBuilder.must().add(multiMatchQueryBuilder);
            }

            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
            long total = elasticsearchRestTemplate.count(nativeSearchQuery, DrugAndIndicationIndex.class);
            List<String> ids = new ArrayList<>();
            if (total > 0) {
                if (total > 10000) total = 10000;
                int pages = (int) (total % 1000 == 0 ? total / 1000 : total / 1000 + 1);
                for (int i = 0; i < pages; i++) {
                    nativeSearchQuery.setPageable(PageRequest.of(i, 1000));
                    SearchHits<DrugAndIndicationIndex> p_search = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
                    List<SearchHit<DrugAndIndicationIndex>> searchHits = p_search.getSearchHits();
                    if (CollUtil.isNotEmpty(searchHits)) {
                        for (SearchHit<DrugAndIndicationIndex> searchHit : searchHits) {
                            ids.add(searchHit.getContent().getId());
                        }
                    }
                }
            }
            if (CollUtil.isNotEmpty(ids)) {
                for (String pid : ids) {
                    DrugInfo drugInfo = ReleaseMongoUtil.mongo.findById(pid, DrugInfo.class);
                    if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getOutbidPrice())) {
//                        drugInfo.setOutbidArea("广东");
                        JSONObject jsonObject = new JSONObject(JSON.parseObject(JSON.toJSONString(drugInfo), new TypeReference<Map<String, Object>>() {
                        }));
                        jsonObject.put("outbidArea", "广东");
                        result.add(jsonObject);
                    }
                }
            }
        }
        return result;
    }

    @Override
    public void export(PaperExportRequest paperExportRequest, HttpServletResponse response) {
        response.setCharacterEncoding("UTF-8");
        Integer type = paperExportRequest.getType();
        List<String> ids = paperExportRequest.getIds();
        if (type == 3) {
            //开始构建xml
            response.setContentType("application/octet-stream");
            response.setHeader("Content-Disposition", "attachment;fileName=" + DateUtil.format(new Date(), "yyyyMMddHHmmss") + ".xml");
            Document document = DocumentHelper.createDocument();
            Element records = document.addElement("records");
            for (String id : ids) {
                MongoLiterature literatureMapping = fineScreenFeign.paper(id);
//                MongoLiterature literatureMapping = ReleaseMongoUtil.mongo.findById(id, MongoLiterature.class, "mongo_literature_" + Math.abs(id.hashCode()) % 10);
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
                log.error(e.getMessage(), e);
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
                MongoLiterature literatureMapping = fineScreenFeign.paper(id);
//                MongoLiterature literatureMapping = ReleaseMongoUtil.mongo.findById(id, MongoLiterature.class, "mongo_literature_" + Math.abs(id.hashCode()) % 10);
                if (literatureMapping != null) {
                    //标题
                    String title = literatureMapping.getTitle() != null ? literatureMapping.getTitle() : "";
                    //作者
                    StringBuilder authorBuilder = new StringBuilder();
                    List<String> author = literatureMapping.getAuthor();
                    if (CollUtil.isNotEmpty(author)) {
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
                //pdfWriter = PdfWriter.getInstance(document, new FileOutputStream(new File("C:\\Users\\Admin\\Desktop\\1.pdf")));
            } catch (IOException | DocumentException e) {
                log.error(e.getMessage(), e);
            }
            document.open();
            for (String id : ids) {
                MongoLiterature literatureMapping = fineScreenFeign.paper(id);
//                MongoLiterature literatureMapping = ReleaseMongoUtil.mongo.findById(id, MongoLiterature.class, "mongo_literature_" + Math.abs(id.hashCode()) % 10);
                if (literatureMapping != null) {
                    //标题
                    String title = literatureMapping.getTitle() != null ? literatureMapping.getTitle() : "";
                    //作者
                    StringBuilder authorBuilder = new StringBuilder();
                    List<String> author = literatureMapping.getAuthor();
                    if (CollUtil.isNotEmpty(author)) {
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
                    if (CollUtil.isNotEmpty(allKeyword)) {
                        for (int i = 0; i < allKeyword.size() - 1; i++) {
                            keywordBuilder.append(allKeyword.get(i)).append(", ");
                        }
                        keywordBuilder.append(allKeyword.get(allKeyword.size() - 1));
                    }
                    try {
                        Font font = new Font(BaseFont.createFont("STSong-Light", "UniGB-UCS2-H", BaseFont.NOT_EMBEDDED), 10, Font.NORMAL);
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
    public PageVo<PaperResponse> showPaperCollect(Long userId, String searchWord, Integer pageSize, Integer pageNum) {
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
        List<PaperResponse> list = new ArrayList<>();
        Object objectStopWord = RedisUtil.redis.opsForValue().get("jieba_word");
        List<String> stopWord = ObjectToListUtil.objToList(objectStopWord, String.class);
        List<String> repairContent = ObjectToListUtil.objToList(objectStopWord, String.class);
        for (SearchHit<PaperIndex> searchHit : searchHits) {
            PaperIndex content = searchHit.getContent();
            String contentId = content.getId();

            //------------本地环境暂时使用正式环境的mongo进行文献的查询----------
            MongoLiterature mongoLiterature = fineScreenFeign.paper(contentId);
//            MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findById(contentId, MongoLiterature.class, "mongo_literature_" + Math.abs(contentId.hashCode()) % 10);

            if (mongoLiterature != null) {
                //高亮显示情况
                List<String> titleList = searchHit.getHighlightField("title");
                List<String> summaryList = searchHit.getHighlightField("summary");
                StringBuilder titleBuilder = new StringBuilder();
                StringBuilder summaryBuilder = new StringBuilder();
                if (CollUtil.isNotEmpty(titleList)) {
                    titleList.forEach(titleBuilder::append);
                }
                if (CollUtil.isNotEmpty(summaryList)) {
                    summaryList.forEach(summaryBuilder::append);
                }
//                mongoLiterature.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? mongoLiterature.getTitle() : highLight(repairContent(titleBuilder.toString(), content.getTitle(), stopWord), mongoLiterature.getTitle(), null, searchWord));
//                mongoLiterature.setSummary(StringUtils.isBlank(summaryBuilder.toString()) ? mongoLiterature.getSummary() : highLight(repairContent(summaryBuilder.toString(), content.getSummary(), stopWord), mongoLiterature.getSummary(), null, searchWord));
                content.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? content.getTitle() : HighLightUtils.repairContent(titleBuilder.toString(), content.getTitle(), repairContent));
                content.setSummary(StringUtils.isBlank(summaryBuilder.toString()) ? content.getSummary() : HighLightUtils.repairContent(summaryBuilder.toString(), content.getSummary(), repairContent));
                PaperResponse paperResponse = FormatUtil.formatPaper(mongoLiterature);
                if (userId != null) {
                    //用户上传的pdf
                    PaperUpload paperUpload = mongoTemplate.findById(contentId, PaperUpload.class);
                    if (paperUpload != null) {
                        String fileUrl = paperUpload.getFileUrl();
                        paperResponse.setFileUrl(fileUrl);
                    }
                }
                list.add(paperResponse);
            }
        }
        long totalHits = searchHits.getTotalHits();
        int pages = (int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1);
        PageVo<PaperResponse> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        return page;
    }


    /**
     * 内部方法，拼接处理修改后质量显示问题的逻辑
     *
     * @param ids1   勾选
     * @param ids2   勾选/不勾选
     * @param ids3   不勾选
     * @param inIds  用户修改后当前查询
     * @param outIds 用户修改后非当前查询
     * @param status 1-1个勾选；2-2个勾选
     */
    private void qualityBool(List<String> ids1, List<String> ids2, List<String> ids3, List<String> inIds, List<String> outIds, Integer status) {
        if (status == 1) {
            //用户只勾选了1个质量等级
            if (CollUtil.isNotEmpty(ids1)) {
                inIds.addAll(ids1);
            }
            if (CollUtil.isNotEmpty(ids2)) {
                outIds.addAll(ids2);
            }
            if (CollUtil.isNotEmpty(ids3)) {
                outIds.addAll(ids3);
            }
        } else {
            //用户勾选了2个质量等级
            if (CollUtil.isNotEmpty(ids1)) {
                inIds.addAll(ids1);
            }
            if (CollUtil.isNotEmpty(ids2)) {
                inIds.addAll(ids2);
            }
            if (CollUtil.isNotEmpty(ids3)) {
                outIds.addAll(ids3);
            }
        }
    }

    @Override
    public ReferencePriceVo showReferencePrice(String id, String search) {
        if (StrUtil.isBlank(id)) {
            throw new RuntimeException("检索课题id不正确！！！");
        }
        Condition condition = mongoTemplate.findById(id, Condition.class);
        ReferencePriceVo referencePriceVo = new ReferencePriceVo();
        if (Objects.nonNull(condition)) {
            List<Drug> drugs = condition.getDrugs();
            List<InterventionAndOutcome> outcomes = condition.getOutcomes();

            List<JSONObject> i_result = getReferencePrice(drugs, null, search);
            List<JSONObject> c_result = getReferencePrice(null, outcomes, search);
            referencePriceVo = new ReferencePriceVo(i_result, c_result);
        }
        return referencePriceVo;
    }

    @Override
    public String excludeReason(ExcludeReasonVo excludeReasonVo, long userId) {
        String paperId = excludeReasonVo.getId();
        if (StrUtil.isBlank(paperId)) {
            return "false";
        }
        ExcludeReasonDTO excludeReasonDTO = new ExcludeReasonDTO();
        BeanUtils.copyProperties(excludeReasonVo, excludeReasonDTO);
//        excludeReasonDTO.setQuestionId("804f9af9-473e-4fc0-a9d9-89bd5a4670fa");
        excludeReasonDTO.setUserId(userId);
        DateTime updateTime = DateTime.now();
        excludeReasonDTO.setUpdateTime(updateTime);
        excludeReasonDTO.setUpdateTimeLong(updateTime.getTime());
        mongoTemplate.save(excludeReasonDTO);
        return "true";
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
        if (Objects.nonNull(paperInfos) && CollUtil.isNotEmpty(paperInfos)) {
            for (PaperInfo paperInfo : paperInfos) {
                PaperInfoModeVo paperInfoModeVo = new PaperInfoModeVo();
                paperInfoModeVo.setInfoId(paperInfo.getInfoId());
                paperInfoModeVo.setTitle(paperInfo.getTitle());
                paperInfoModeVo.setContent(paperInfo.getContent());
                paperInfoModeVos.add(paperInfoModeVo);
            }

            if (CollUtil.isNotEmpty(paperInfoModeVos)) {
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
                if (CollUtil.isNotEmpty(mongoLiterature.getLastNewType()) && Constants.OTHER_LITERATURE_TYPE.contains(studyType)) {
                    PaperInfoModeVo paperInfoModeVo = new PaperInfoModeVo();

                    List<String> author = mongoLiterature.getAuthor();
                    String year = mongoLiterature.getYear();
                    // 文献来源
                    String source = "";
                    if (CollUtil.isNotEmpty(author)) {
                        source = author.get(0) + " " + year;
                    } else {
                        source = "未知" + " " + year;
                    }
                    paperInfoModeVo.setInfoId("1");
                    paperInfoModeVo.setTitle("文献来源");
                    paperInfoModeVo.setContent(source);
                    paperInfoModeVos.add(paperInfoModeVo);
                    Snowflake snowflake = new Snowflake();
                    PaperInfo paperInfo = new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "1", "文献来源", StrUtil.isNotBlank(source) ? source : "-", pdfUrl);
                    paperInfos.add(paperInfo);
                    // 年份
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("2");
                    paperInfoModeVo.setTitle("年份");
                    paperInfoModeVo.setContent(year);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "2", "年份", StrUtil.isNotBlank(year) ? year : "-", pdfUrl));
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
                            if (mongoLiterature.getType().contains(7)) {
                                studyTypeBuilder.append("临床试验、");
                            }
                        }
                    } else {
                        if (CollUtil.isNotEmpty(mongoLiterature.getType())) {
                            if (mongoLiterature.getType().contains(7)) {
                                studyTypeBuilder.append("临床试验、");
                            }
                        } else {
                            studyTypeBuilder.append(" ");
                        }
                    }
                    // 研究类型
                    String studyTypeName = studyTypeBuilder.toString();
                    if (StrUtil.isNotBlank(studyTypeName)) {
                        studyTypeName = studyTypeName.substring(0, studyTypeName.length() - 1);
                    }
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("3");
                    paperInfoModeVo.setTitle("试验类型");
                    paperInfoModeVo.setContent(studyTypeName);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "3", "试验类型", StrUtil.isNotBlank(studyTypeName) ? studyTypeName : "-", pdfUrl));
                    // 实验组干预指标
                    List<String> ic = mongoLiterature.getIc();
                    String ic_str = "-";
                    if (CollUtil.isNotEmpty(ic)) {
                        ic_str = String.join("、", ic);
                    }
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("4");
                    paperInfoModeVo.setTitle("试验组");
                    paperInfoModeVo.setContent(ic_str);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "4", "试验组", StrUtil.isNotBlank(ic_str) ? ic_str : "-", pdfUrl));

                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("5");
                    paperInfoModeVo.setTitle("对照组");
                    paperInfoModeVo.setContent("-");
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "5", "对照组", "-", pdfUrl));
                    // 结局指标
                    String index = "-";
                    if (CollUtil.isNotEmpty(mongoLiterature.getO())) {
                        index = String.join("、", mongoLiterature.getO());
                    }
                    // 结果
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("6");
                    paperInfoModeVo.setTitle("结局指标");
                    paperInfoModeVo.setContent(index);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "6", "结局指标", StrUtil.isNotBlank(index) ? index : "-", pdfUrl));
                    // 结论
                    String conclusion = mongoLiterature.getConclusion();
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("7");
                    paperInfoModeVo.setTitle("结论");
                    paperInfoModeVo.setContent(conclusion);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "7", "结论", StrUtil.isNotBlank(conclusion) ? conclusion : "-", pdfUrl));
                    paperInfoVo.setPaperInfoModeVos(paperInfoModeVos);
                    paperInfoVo.setPdfUrl(pdfUrl);
                }
                // 经济类型的不一样
                if (CollUtil.isNotEmpty(mongoLiterature.getLastNewType()) && Constants.ECONOMY_LITERATURE_TYPE.contains(studyType)) {
                    PaperInfoModeVo paperInfoModeVo = new PaperInfoModeVo();
                    List<String> author = mongoLiterature.getAuthor();
                    String year = mongoLiterature.getYear();
                    // 来源
                    String source = author.get(0) + " " + year;
                    source = StrUtil.isNotBlank(source) ? source : "-";
                    paperInfoModeVo.setInfoId("1");
                    paperInfoModeVo.setTitle("文献来源");
                    paperInfoModeVo.setContent(source);
                    paperInfoModeVos.add(paperInfoModeVo);
                    Snowflake snowflake = new Snowflake();
                    PaperInfo paperInfo = new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "1", "文献来源", source, pdfUrl);
                    paperInfos.add(paperInfo);
                    // 年份
                    year = StrUtil.isNotBlank(year) ? year : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("2");
                    paperInfoModeVo.setTitle("年份");
                    paperInfoModeVo.setContent(year);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "2", "年份", year, pdfUrl));
                    // 研究国家
                    String country = StrUtil.isNotBlank(mongoLiterature.getEconomicsResearchCountry()) ? mongoLiterature.getEconomicsResearchCountry() : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("3");
                    paperInfoModeVo.setTitle("研究国家");
                    paperInfoModeVo.setContent(country);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "3", "研究国家", country, pdfUrl));
                    // 研究方法
                    String method = StrUtil.isNotBlank(mongoLiterature.getEconomicsEvaluationMethods()) ? mongoLiterature.getEconomicsEvaluationMethods() : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("4");
                    paperInfoModeVo.setTitle("研究方法");
                    paperInfoModeVo.setContent(method);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "4", "研究方法", method, pdfUrl));
                    // 研究方案
                    String ic = StrUtil.isNotBlank(mongoLiterature.getEconomicsIC()) ? mongoLiterature.getEconomicsIC() : "-";
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
                    String o = StrUtil.isNotBlank(mongoLiterature.getEconomicsO()) ? mongoLiterature.getEconomicsO() : "-";
                    paperInfoModeVo = new PaperInfoModeVo();
                    paperInfoModeVo.setInfoId("7");
                    paperInfoModeVo.setTitle("结局指标");
                    paperInfoModeVo.setContent(o);
                    paperInfoModeVos.add(paperInfoModeVo);
                    paperInfos.add(new PaperInfo(snowflake.nextIdStr(), paperId, questionId, "7", "结局指标", o, pdfUrl));
                    // 结论
                    String conclusion = StrUtil.isNotBlank(mongoLiterature.getEconomicsConclusion()) ? mongoLiterature.getEconomicsConclusion() : "-";
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

        if (CollUtil.isNotEmpty(paperInfos)) {
            paperInfoService.saveOrUpdateBatch(paperInfos);
        }
        result.put("result", "3");
        result.put("resultMsg", "解析成功");
        result.put("data", paperInfoVo);
        return result;
    }

    @Override
    public Boolean savePaperInfo(PaperInfoEditVo paperInfoEditVo) {
        if (Objects.isNull(paperInfoEditVo)) {
            return false;
        }
        PaperInfo pdfInfoBo = new PaperInfo();
        BeanUtils.copyProperties(paperInfoEditVo, pdfInfoBo);
        Snowflake snowflake = new Snowflake();
        pdfInfoBo.setId(snowflake.nextIdStr());
        String paperId = paperInfoEditVo.getPaperId();
        String questionId = paperInfoEditVo.getQuestionId();
        String infoId = paperInfoEditVo.getInfoId();
        String content = paperInfoEditVo.getContent();
        if (StrUtil.isBlank(paperId) || StrUtil.isBlank(questionId) || StrUtil.isBlank(infoId)) {
            return false;
        }
        PaperInfo paperInfo = paperInfoService.getPaperInfoByPaperIdAndQuestionId(paperId, questionId, infoId);
        if (Objects.isNull(paperInfo)) {
            return false;
        }
        paperInfo.setContent(content);
        paperInfoService.saveOrUpdate(paperInfo);
        return true;
    }

    @Override
    public Map<String, Object> getAlgInitial(String paperId, String questionId, long userId, String studyType) {
        Date begin = new Date();
        Map<String, Object> result = new HashMap<>();

        MongoLiterature paperIndex = fineScreenFeign.paper(paperId);
//        MongoLiterature paperIndex = ReleaseMongoUtil.mongo.findById(paperId, MongoLiterature.class, "mongo_literature_" + Math.abs(paperId.hashCode()) % 10);
        if (Objects.nonNull(paperIndex)) {
            List<Integer> lastNewType = paperIndex.getLastNewType();
//            // 多标签情况下 经济和他其他多标签 当前分析为经济学 不予分析
//            if (CollUtil.isNotEmpty(lastNewType) && lastNewType.size() > 1 && lastNewType.contains(12) && "12".equals(studyType)) {
//                result.put("result", "2");
//                result.put("resultMsg", "文献从属于多个研究类型时，系统选取研究类型为非经济学类型进行文献质量评价！");
//                return result;
//            }
            if (!Constants.ALG_STUDY_TYPES_META_RCT_ECONOMY.contains(studyType)) {
                result.put("result", "2");
                result.put("resultMsg", "质量分析只支持Meta、RCT/nRCT、经济类型文献！");
                return result;
            }
        }

        Snowflake snowflake = new Snowflake();
        List<AlgPdfModeVo> algPdfModeVos = new ArrayList<>();
        PdfAnalysis pdfAnalysis = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(paperId)
                .and("userId").is(userId)
                .and("questionId").is(questionId)
                .and("paperType").is(studyType)), PdfAnalysis.class);
        // 先从数据库获取结果，如果未获取到则是第一次获取
        List<PdfEdit> paperStandards = pdfEditService.getPaperStandardsByPaperIdAndQuestionId(paperId, questionId);
        if (CollUtil.isNotEmpty(paperStandards) && Objects.nonNull(pdfAnalysis)) {
            // 用来评价 meta 类型的质量高中低
            List<String> preListMeta = new ArrayList<>();
            int yesNum = 0;
            int partNum = 0;
            int noNum = 0;
            int notApplicableNum = 0;
            int otherNum = 0;

            // 二者不相等 证明pdf 被替换了
            if (Objects.equals(paperStandards.get(0).getPath(), pdfAnalysis.getPath())) {
                for (PdfEdit paperStandard : paperStandards) {
                    AlgPdfModeVo algPdfModeVo = new AlgPdfModeVo();
                    algPdfModeVo.setModeId(paperStandard.getStandardId());
                    algPdfModeVo.setTitle(paperStandard.getTitle());
                    algPdfModeVo.setTitleTips(paperStandard.getTitleTips());
                    algPdfModeVo.setBody(paperStandard.getBody());
                    algPdfModeVo.setReason(paperStandard.getReason());
                    String predict = paperStandard.getStandardValue();
                    algPdfModeVo.setPredict(predict);

                    // 目前只有 meta 会评价高中低
                    if ("0".equals(studyType)) {
                        algPdfModeVo.setPredict(predict);
                    }
                    preListMeta.add(predict);
                    algPdfModeVos.add(algPdfModeVo);

                    // 经济类型需要统计是、否、部分是、以及不适用的个数
                    if ("12".equals(studyType) && StrUtil.isNotBlank(predict)) {
                        PredictResultEnum of = PredictResultEnum.of(predict);
                        if (Objects.nonNull(of)) { // 有可能是这四个以外的情况
                            if ("是".equals(of.getResult())) {
                                yesNum++;
                            }
                            if ("否".equals(of.getResult())) {
                                noNum++;
                            }
                            if ("部分是".equals(of.getResult())) {
                                partNum++;
                            }
                            if ("不适用".equals(of.getResult())) {
                                notApplicableNum++;
                            }
                        } else {
                            otherNum++;
                        }
                    }
                }

                if (CollUtil.isNotEmpty(algPdfModeVos)) {
                    AlgPdfAnalysisVo algPdfAnalysisVo = new AlgPdfAnalysisVo();
                    // 目前只有 meta 会评价高中低
                    String metaQuality = judgePaperQuality(preListMeta);
                    algPdfAnalysisVo.setQualityMeta(metaQuality);
                    if (!"0".equals(studyType)) {
                        algPdfAnalysisVo.setQualityMeta(null);
                    }
                    algPdfAnalysisVo.setAlgPdfModeVos(algPdfModeVos);
                    algPdfAnalysisVo.setType(studyType);

                    // 经济类型计算是、否、不适用、部分是的数量
                    algPdfAnalysisVo.setYesNum(yesNum);
                    algPdfAnalysisVo.setNoNum(noNum);
                    algPdfAnalysisVo.setPartNum(partNum);
                    algPdfAnalysisVo.setNotApplicableNum(notApplicableNum);
                    algPdfAnalysisVo.setOtherNum(otherNum);

                    // 存储一份最新的结果
                    PdfEditResult paperEditResult = pdfEditResultService.getPaperEditResultPaperIdAndQuestionId(paperId, questionId, studyType);
                    if (Objects.nonNull(paperEditResult)) {
                        if ("0".equals(studyType)) {
                            paperEditResult.setQualityMeta(metaQuality);
                            pdfEditResultService.saveOrUpdate(paperEditResult);
                        }
                        if ("12".equals(studyType)) {
                            paperEditResult.setYesNum(yesNum);
                            paperEditResult.setNoNum(noNum);
                            paperEditResult.setPartNum(partNum);
                            paperEditResult.setNotApplicableNum(notApplicableNum);
                            paperEditResult.setOtherNum(otherNum);
                            pdfEditResultService.saveOrUpdate(paperEditResult);
                        }
                    } else {
                        PdfEditResult pdfEditResult = new PdfEditResult(snowflake.nextIdStr(), paperId, studyType, questionId, metaQuality, yesNum, noNum, partNum, notApplicableNum, otherNum);
                        pdfEditResultService.save(pdfEditResult);
                    }
                    result.put("result", "3");
                    result.put("resultMsg", "解析成功");
                    result.put("data", algPdfAnalysisVo);
                    return result;
                }
            } else {
                pdfEditService.deletePdfEditByPaperIdAndQuestionId(paperId, questionId);
                pdfEditResultService.deletePdfEditResultByPaperIdAndQuestionId(paperId, questionId);
            }
        }


        // 第一次访问保存质量评价结果 或者pdf 被替换 需要再次解析新结果
        List<PdfEdit> pdfEdits = new ArrayList<>();
        while (new Date().getTime() - begin.getTime() < 1000 * 60 * 3.5) {
            try {
                PdfAnalysis innerPdfAnalysis = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(paperId)
                        .and("userId").is(userId)
                        .and("questionId").is(questionId)
                        .and("paperType").is(studyType)), PdfAnalysis.class);
                if (Objects.nonNull(innerPdfAnalysis) && Objects.nonNull(innerPdfAnalysis.getAlgSuccess())) {
                    if (!innerPdfAnalysis.getAlgSuccess()) {
                        result.put("result", "3");
                        result.put("resultMsg", "解析失败，请重新上传");
                        return result;
                    }

                    JSONObject data = innerPdfAnalysis.getData();
                    List<String> preListMeta = new ArrayList<>();
                    int yesNum = 0;
                    int partNum = 0;
                    int noNum = 0;
                    int notApplicableNum = 0;
                    int otherNum = 0;
                    if (Objects.nonNull(data)) {
                        JSONArray result_data = data.getJSONArray("result_data");
                        for (Object result_datum : result_data) {
                            int status = 0;
                            AlgPdfModeVo algPdfModeVo = new AlgPdfModeVo();
                            JSONObject model = JSON.parseObject(JSON.toJSONString(result_datum), JSONObject.class);
                            String reason = model.getString("reason");
                            String modeId = model.getString("id");
                            algPdfModeVo.setReason(reason);
                            algPdfModeVo.setModeId(modeId);
                            String predict = "";
                            String title = "";
                            String titleTips = "";
                            if ("0".equals(studyType)) {
                                predict = model.getString("predict");
                                if (!Constants.QUALITY_RESULT.contains(predict)) {
                                    predict = "否";
                                }
                                preListMeta.add(predict);
                                title = PaperEditMetaEnum.of(modeId).getTitle();
                                algPdfModeVo.setTitle(title);
                                titleTips = PaperEditMetaEnum.of(modeId).getTitleTips();
                                algPdfModeVo.setTitleTips(titleTips);
                            }
                            if ("2".equals(studyType)) {
                                predict = model.getString("predict");
                                if (!Constants.QUALITY_RESULT.contains(predict)) {
                                    predict = "NC";
                                }
                                title = PaperEditRctEnum.of(modeId).getTitle();
                                titleTips = title;
                                algPdfModeVo.setTitleTips(titleTips);
                                algPdfModeVo.setTitle(title);
                            }
                            // 经济类型需要统计 是、否、部分是、不适用的个数
                            if ("12".equals(studyType)) {
                                predict = model.getString("predict");
                                if (!Constants.QUALITY_RESULT.contains(predict)) {
                                    predict = "否";
                                }
                                PredictResultEnum of = PredictResultEnum.of(predict);
                                if (Objects.nonNull(of)) {
                                    if ("是".equals(of.getResult())) {
                                        yesNum++;
                                    }
                                    if ("否".equals(of.getResult())) {
                                        noNum++;
                                    }
                                    if ("部分是".equals(of.getResult())) {
                                        partNum++;
                                    }
                                    if ("不适用".equals(of.getResult())) {
                                        notApplicableNum++;
                                    }
                                } else {
                                    otherNum++;
                                }
                                title = PaperEditEconomyEnum.of(modeId).getTitle();
                                titleTips = title;
                                algPdfModeVo.setTitleTips(titleTips);
                                algPdfModeVo.setTitle(title);
                            }
                            algPdfModeVo.setPredict(predict);
                            JSONArray reference = model.getJSONArray("reference");
//                                List<JSONObject> reference = JSON.parseObject(JSON.toJSONString(model.getJSONArray("reference")), new TypeReference<List<JSONObject>>() {});
                            algPdfModeVo.setBody(reference);
                            algPdfModeVos.add(algPdfModeVo);
                            // 存储质量评价解析结果
                            PdfEdit pdfEdit = PdfEdit.builder()
                                    .id(snowflake.nextIdStr())
                                    .paperId(paperId)
                                    .paperType(studyType)
                                    .questionId(questionId)
                                    .standardId(modeId)
                                    .title(title)
                                    .titleTips(titleTips)
                                    .standardValue(predict)
                                    .body(reference)
                                    .reason(reason)
                                    .path(innerPdfAnalysis.getPath())
                                    .status(status)
                                    .createTime(new Date())
                                    .build();
                            pdfEdits.add(pdfEdit);
                        }
                    }

                    // rct 是分析不出来 5 和 6 的 所以默认为分析不出来
                    if ("2".equals(studyType)) {
                        AlgPdfModeVo algPdfModeVo5 = new AlgPdfModeVo();
                        algPdfModeVo5.setModeId("5");
                        algPdfModeVo5.setTitle("报告偏倚");
                        algPdfModeVo5.setTitleTips("报告偏倚");
                        algPdfModeVo5.setBody(new JSONArray());
                        algPdfModeVo5.setPredict("NC");
                        algPdfModeVo5.setReason("");
                        algPdfModeVos.add(algPdfModeVo5);
                        AlgPdfModeVo algPdfModeVo6 = new AlgPdfModeVo();
                        algPdfModeVo6.setModeId("6");
                        algPdfModeVo6.setTitle("其他偏倚");
                        algPdfModeVo6.setTitleTips("其他偏倚");
                        algPdfModeVo6.setBody(new JSONArray());
                        algPdfModeVo6.setPredict("NC");
                        algPdfModeVo6.setReason("");
                        algPdfModeVos.add(algPdfModeVo6);
                        // 存储质量评价解析结果
                        PdfEdit pdfEdit5 = new PdfEdit(snowflake.nextIdStr(), paperId, studyType, questionId, "5", "报告偏倚", "报告偏倚", "none", new JSONArray(), "", innerPdfAnalysis.getPath(), 0, new Date());
                        pdfEdits.add(pdfEdit5);
                        PdfEdit pdfEdit6 = new PdfEdit(snowflake.nextIdStr(), paperId, studyType, questionId, "6", "其他偏倚", "其他偏倚", "none", new JSONArray(), "", innerPdfAnalysis.getPath(), 0, new Date());
                        pdfEdits.add(pdfEdit6);
                    }

                    // 保存质量评价结果
                    if (CollUtil.isNotEmpty(pdfEdits)) {
                        pdfEditService.saveOrUpdateBatch(pdfEdits);
                    }

                    // 返回实体
                    AlgPdfAnalysisVo algPdfAnalysisVo = new AlgPdfAnalysisVo();
                    algPdfAnalysisVo.setAlgPdfModeVos(algPdfModeVos);
                    algPdfAnalysisVo.setType(studyType);
                    String metaQuality = judgePaperQuality(preListMeta);
                    algPdfAnalysisVo.setQualityMeta(metaQuality);
                    algPdfAnalysisVo.setQualityMeta(metaQuality);
                    if (!"0".equals(studyType)) {
                        algPdfAnalysisVo.setQualityMeta(null);
                    }
                    algPdfAnalysisVo.setYesNum(yesNum);
                    algPdfAnalysisVo.setNoNum(noNum);
                    algPdfAnalysisVo.setPartNum(partNum);
                    algPdfAnalysisVo.setNotApplicableNum(notApplicableNum);
                    algPdfAnalysisVo.setOtherNum(otherNum);

                    PdfEditResult paperEditResult = pdfEditResultService.getPaperEditResultPaperIdAndQuestionId(paperId, questionId, studyType);
                    if (Objects.nonNull(paperEditResult)) {
                        if ("0".equals(studyType)) {
                            paperEditResult.setQualityMeta(metaQuality);
                            pdfEditResultService.saveOrUpdate(paperEditResult);
                        }
                        if ("12".equals(studyType)) {
                            paperEditResult.setYesNum(yesNum);
                            paperEditResult.setNoNum(noNum);
                            paperEditResult.setPartNum(partNum);
                            paperEditResult.setNotApplicableNum(notApplicableNum);
                            paperEditResult.setOtherNum(otherNum);
                            pdfEditResultService.saveOrUpdate(paperEditResult);
                        }
                    } else {
                        PdfEditResult pdfEditResult = new PdfEditResult(snowflake.nextIdStr(), paperId, studyType, questionId, metaQuality, yesNum, noNum, partNum, notApplicableNum, otherNum);
                        pdfEditResultService.save(pdfEditResult);
                    }
                    result.put("result", "3");
                    result.put("resultMsg", "解析成功！");
                    result.put("data", algPdfAnalysisVo);
                    return result;
                }
                Thread.sleep(1000 * 5);
                log.info("当前锁{}，等待时间是{}", paperId, new Date().getTime() - begin.getTime());
            } catch (Exception e) {
                log.error(e.getMessage(), e);
                result.put("result", "1");
                result.put("resultMsg", "解析失败！");
                return result;
            }
        }

        if (new Date().getTime() - begin.getTime() > 1000 * 60 * 10) {
            result.put("result", "1");
            result.put("resultMsg", "解析失败！");
            return result;
        }
        result.put("result", "2");
        result.put("resultMsg", "文献正在解析中，请稍后点击查看！");
        return result;
    }

    /**
     * 判断 meta 类型质量评价整体结果
     */
    public String judgePaperQuality(List<String> qualities) {
        String quality = "极低";
        int highQualityYes = 0;
        int highQualityNo = 0;
        int lowQualityYes = 0;
        int lowQualityNo = 0;
        if (CollUtil.isNotEmpty(qualities)) {
            for (int i = 0; i < qualities.size(); i++) {
                PredictResultEnum of = PredictResultEnum.of(qualities.get(i));
                if (Objects.nonNull(of)) {
                    if ("是".equals(of.getResult())) {
                        if (Constants.META_HIGH_QUALITY_TERM.contains(i+1)) {
                            highQualityYes++;
                        } else {
                            lowQualityYes++;
                        }
                    }
                    if ("否".equals(of.getResult())) {
                        if (Constants.META_HIGH_QUALITY_TERM.contains(i+1)) {
                            highQualityNo++;
                        } else {
                            lowQualityNo++;
                        }
                    }
                    if ("部分是".equals(of.getResult())) {
                        if (Constants.META_HIGH_QUALITY_TERM.contains(i+1)) {
                            highQualityNo++;
                        } else {
                            lowQualityNo++;
                        }
                    }
                    if ("不适用".equals(of.getResult())) {
                        if (Constants.META_HIGH_QUALITY_TERM.contains(i+1)) {
                            highQualityYes++;
                        } else {
                            lowQualityYes++;
                        }
                    }
                }
            }
        }
        if (highQualityYes == 7) {
            if (lowQualityYes>= 8) {
                quality = "高";  // 条目2、4、7、9、11、13、15 全是 是，且其他条目大于 8 个是
            } else {
                quality = "中"; // 条目2、4、7、9、11、13、15 全是 是，且其他条目大于 7 个是
            }
        }
        if (highQualityYes == 6) {  // 条目2、4、7、9、11、13、15中：=1个条目是“否”
            quality = "低";
        }
        if (highQualityYes < 6) {
            quality = "极低";
        }
        return quality;
    }

    @Override
    public Boolean savePaperStandard(PaperStandardVo paperStandardVo) {
        if (Objects.isNull(paperStandardVo)) {
            return false;
        }
        PdfEdit pdfEdit = new PdfEdit();
        BeanUtils.copyProperties(paperStandardVo, pdfEdit);
        Snowflake snowflake = new Snowflake();
        pdfEdit.setId(snowflake.nextIdStr());
        String paperId = paperStandardVo.getPaperId();
        String questionId = paperStandardVo.getQuestionId();
        String standardId = paperStandardVo.getStandardId();
        String standardValue = paperStandardVo.getStandardValue();
        if (StrUtil.isBlank(paperId) || StrUtil.isBlank(questionId) || StrUtil.isBlank(standardId)) {
            return false;
        }
        PdfEdit paperStandard = pdfEditService.getPaperStandardByPaperIdAndQuestionId(paperId, questionId, standardId);
        if (Objects.nonNull(paperStandard)) {
            paperStandard.setStandardValue(standardValue);
            pdfEditService.saveOrUpdate(paperStandard);
        } else {
            pdfEditService.save(pdfEdit);
        }
        return true;
    }

    @Override
    public PageVo<String> getAlgPdf(PdfRequestRequest pdfRequestRequest, long userId) {
        PageVo<String> pageVo = new PageVo<>();
        if (Objects.isNull(pdfRequestRequest)) {
            return pageVo;
        }
        if (StrUtil.isBlank(pdfRequestRequest.getId())) {
            return pageVo;
        }

        String questionId = pdfRequestRequest.getQuestionId();
        String id = pdfRequestRequest.getId();
        PdfAnalysis pdfAnalysis = new PdfAnalysis();
        pdfAnalysis.setPaperId(id);
        pdfAnalysis.setAlgSuccess(false);

        PdfAnalysis mongo = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(id).and("userId").is(userId).and("questionId").is(questionId)), PdfAnalysis.class);
        if (Objects.nonNull(mongo)) {
            pdfAnalysis = mongo;
        }

        // 因为图片的转换需要时间，所以需要等待pdf全部转为图片在返回成功
        if (Objects.nonNull(pdfAnalysis.getAlgSuccess()) || !pdfAnalysis.getAlgSuccess()) {
            try {
                for (int i = 0; i < 80; i++) {
                    Thread.sleep(6000);
                    PdfAnalysis mongo_inner = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(id).and("userId").is(userId).and("questionId").is(questionId)), PdfAnalysis.class);
                    if (Objects.nonNull(mongo_inner)) {
                        // 看 pdf 是否转图片成功，如果失败就直接返回，成功跳出循环
                        if (!mongo_inner.getAlgSuccess()) {
                            return pageVo;
                        } else {
                            pdfAnalysis = mongo_inner;
                            break;
                        }
                    }
                }
            } catch (InterruptedException e) {
                log.error(e.getMessage(), e);
            }
        }
        
        if (Objects.nonNull(pdfAnalysis.getAlgSuccess()) && pdfAnalysis.getAlgSuccess()) {
            // 图片ftp路径 路径格式是 sftpPath/image_pdf/pdf名称/文献id_页码.type
            String ipAlgFilePath = ""; // 公网可访问的图片路径

            String type = pdfAnalysis.getType();

            if (StrUtil.isNotBlank(pdfAnalysis.getAlgFilePath())) {
                ipAlgFilePath = pdfAnalysis.getAlgFilePath();
            }

            if (pdfRequestRequest.getModeId() == null || StrUtil.isBlank(pdfRequestRequest.getModeId().toString())) {
                ipAlgFilePath = CommonUtil.removeSeparatorFromSuffix(ipAlgFilePath).concat(Constants.PAD_LEFT_SLASH).concat(id + "_" + (pdfRequestRequest.getPageNum() - 1)).concat(Constants.PAD_DOT).concat(type);
            } else {
                //后期生成4角坐标
                analysis(pdfAnalysis, pdfRequestRequest.getModeId(), userId);

                if (Objects.nonNull(pdfRequestRequest.getModeId()) && Objects.nonNull(pdfRequestRequest.getModePageNum())) {
                    ipAlgFilePath = CommonUtil.removeSeparatorFromSuffix(ipAlgFilePath).concat(Constants.PAD_LEFT_SLASH).concat(pdfRequestRequest.getModeId().toString()).concat(Constants.PAD_LEFT_SLASH).concat(id + "_" + (pdfRequestRequest.getModePageNum() - 1)).concat(Constants.PAD_DOT).concat(type);
                } else {
                    ipAlgFilePath = CommonUtil.removeSeparatorFromSuffix(ipAlgFilePath).concat(Constants.PAD_LEFT_SLASH).concat(pdfRequestRequest.getModeId().toString()).concat(Constants.PAD_LEFT_SLASH).concat(id + "_" + (pdfRequestRequest.getPageNum() - 1)).concat(Constants.PAD_DOT).concat(type);
                }
            }

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
                    InputStream inputStream = channelSftp.get(ipAlgFilePath);
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
        pageVo.setPages(0);  // todo 如果 5分钟之后 还没有获取到 是不是 如果确实成功了需要删除图片等等信息
        return pageVo;
    }
    private void analysis(PdfAnalysis pdfAnalysis, Integer modeId, long userId) {
        if (Objects.nonNull(pdfAnalysis.getSuccess()) && !pdfAnalysis.getSuccess())  {  // 如果图片都没转换成功直接 pass
            return;
        }
        String paperId = pdfAnalysis.getPaperId();
        JSONObject paperModeAddress = mongoTemplate.findOne(new Query(Criteria.where("paperId").is(paperId).and("userId").is(userId)), JSONObject.class, "paper_mode_address");
        if (paperModeAddress != null) {
            JSONArray jsonArray = paperModeAddress.getJSONArray(modeId.toString());
            if (jsonArray != null && !jsonArray.isEmpty()) {
                return;
            }
        }
        Session jschSession = null;
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
            ChannelSftp channelSftp = (ChannelSftp) sftp;

            // 算法解析的数据
            List<String> list = new ArrayList<>();
            JSONArray result_data = pdfAnalysis.getData().getJSONArray("result_data");
            Integer imagesCount = pdfAnalysis.getImagesCount();
            for (Object result_datum : result_data) {
                JSONObject model = JSON.parseObject(JSON.toJSONString(result_datum), JSONObject.class);
                // 每个标准 modeId 对应的会有多个 四角坐标的解析结果
                JSONArray reference = model.getJSONArray("reference");
                String id = model.getString("id"); // 文献 id
                if (id.equals(modeId.toString())) {
                    if (CollUtil.isNotEmpty(reference)) {
                        HashSet<Object> tempCount = new HashSet<>();
                        for (Object o : reference) {
                            JSONObject number = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                            JSONArray bbox = number.getJSONArray("bbox");
                            if (StrUtil.isNumeric(number.getString("page")) && Objects.nonNull(bbox) && CollUtil.isNotEmpty(bbox)) {
                                tempCount.add(number.getString("page"));
                                try {
                                    Integer page = number.getInteger("page");
                                    drawPicBy4XY(channelSftp, pdfAnalysis, page, bbox, id, modeId, -1, true);
                                    String path = pdfAnalysis.getAlgFilePath() + Constants.PAD_LEFT_SLASH + modeId + Constants.PAD_LEFT_SLASH + paperId + "_" + (page) + "." + pdfAnalysis.getType();
                                    list.add(path);
                                } catch (Exception e) {
                                    log.error(e.getMessage(), e);
                                }
                            }
                        }
                        for (int i = 0; i < imagesCount; i++) {
                            if (!tempCount.contains(String.valueOf(i))) {
                                try {
                                    drawPicBy4XY(channelSftp, pdfAnalysis, i, new JSONArray(), id, modeId, i, false);
                                    String path = pdfAnalysis.getAlgFilePath() + Constants.PAD_LEFT_SLASH + modeId + Constants.PAD_LEFT_SLASH + paperId + "_" + (i) + "." + pdfAnalysis.getType();
                                    list.add(path);
                                } catch (Exception e) {
                                    log.error(e.getMessage(), e);
                                }
                            }

                        }


                    }
                }
            }
            channelSftp.exit();
            if (paperModeAddress != null) {
                paperModeAddress.put(modeId.toString(), list);
            } else {
                paperModeAddress = new JSONObject();
                paperModeAddress.put("paperId", paperId);
                paperModeAddress.put("userId", userId);
                paperModeAddress.put(modeId.toString(), list);
            }
            mongoTemplate.remove(new Query(Criteria.where("paperId").is(paperId).and("userId").is(userId)), JSONObject.class, "paper_mode_address");
            mongoTemplate.save(paperModeAddress, "paper_mode_address");
        } catch (JSchException e) {
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
    }


    private void drawPicBy4XY(ChannelSftp channelSftp, PdfAnalysis pdfAnalysis, Integer page, JSONArray bbox, String id, Integer modeId, int i, boolean flag) throws IOException {
        // 将图片进行四角坐标标记
        String paperId = pdfAnalysis.getPaperId();
        String type = pdfAnalysis.getType();
        String algFilePath = pdfAnalysis.getAlgFilePath();
        // 四角坐标
        List<Integer> coordinates = JSON.parseObject(JSON.toJSONString(bbox), new TypeReference<List<Integer>>() {});
        // 文件存储服务器地址
        String remoteAlgFilename = algFilePath + Constants.PAD_LEFT_SLASH + paperId + "_" + (page) + "." + type;
        String remoteAlgModelIdFilename = algFilePath + Constants.PAD_LEFT_SLASH + modeId + Constants.PAD_LEFT_SLASH + paperId + "_" + (page) + "." + type;
        String remoteAlgModelIdPath = algFilePath + Constants.PAD_LEFT_SLASH + modeId;

        if (!flag) {
            try {
                remoteAlgModelIdFilename = algFilePath + Constants.PAD_LEFT_SLASH + modeId + Constants.PAD_LEFT_SLASH + paperId + "_" + (i) + "." + type;

                // 在每个线程中获取或创建一个新的InputStream
                //            InputStream inputStream = getInputStreamForThread(remoteAlgFilename, channelSftp);
                InputStream inputStream = channelSftp.get(remoteAlgFilename);
                // 读取图片文件，得到BufferedImage对象
                BufferedImage image = ImageIO.read(inputStream);
                // 注意注意 一定要关闭 input 流  否则 你会遇到不知道怎么解决的办法
                //            closeInputStreamForThread();
                inputStream.close();
                // 四角坐标图片存放路径
                String localPath = pdfToImagePath + paperId + "_" + (page) + "." + type;
                File file = new File(localPath);
                // 将image 流写入文件
                ImageIO.write(image, type, file);
                if (file.exists()) {
                    // 也是因为目前如果一个用户上传 pdf 成功之后到算法解析完成之前都是不允许再次上传的 所以不会出现目录不存在的问题，
                    // 但是如果支持并发上传就会出现目录不存在问题。
                    boolean exists = SftpUtils.directoryExists(channelSftp, algFilePath);
                    if (!exists) {
                        SftpUtils.mkdirDirs(algFilePath, channelSftp);
                    }

                    boolean modelIdexists = SftpUtils.directoryExists(channelSftp, remoteAlgModelIdPath);
                    if (!modelIdexists) {
                        SftpUtils.mkdirDirs(remoteAlgModelIdPath, channelSftp);
                    }
                    channelSftp.put(localPath, remoteAlgModelIdFilename);
                    boolean delete = FileUtil.del(file);
                    if (delete) {
                        log.info("文献{}的id为{}的第{}张算法画四角坐标解析完成并且删除成功", paperId, id, page);
                    } else {
                        log.info("本地图片删除失败,路径{}", localPath);
                    }
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
                return;
            }
            return;
        }

        // 远程图片文件 流文件
        // 两人同时上传的时候第二个人会把第一个人的删除  第一个人 获取的时候就是 null  no such file    todo
        try {
            // 在每个线程中获取或创建一个新的InputStream
            //            InputStream inputStream = getInputStreamForThread(remoteAlgFilename, channelSftp);
            InputStream inputStream = null;
            try {
                inputStream = channelSftp.get(remoteAlgModelIdFilename);
            } catch (Exception e) {
                inputStream = channelSftp.get(remoteAlgFilename);
            }
            // 读取图片文件，得到BufferedImage对象
            BufferedImage image = ImageIO.read(inputStream);
            // 注意注意 一定要关闭 input 流  否则 你会遇到不知道怎么解决的办法
            //            closeInputStreamForThread();
            inputStream.close();
            // 得到Graphics2D 对象
            Graphics2D g2d=(Graphics2D)image.getGraphics();
            // 设置颜色和画笔粗细
            g2d.setColor(Color.RED);
            g2d.setStroke(new BasicStroke(8));
            // 四角坐标
            List<List<Integer>> list = Collections.singletonList(coordinates);
            for (List<Integer> integerList : list) {
                int x = integerList.get(0);
                int y = integerList.get(1);
                int width = integerList.get(2) - x;
                int height = integerList.get(3) - y;
                g2d.draw3DRect(x, y, width, height, false);
            }
            // 四角坐标图片存放路径
            String localPath = pdfToImagePath + paperId + "_" + (page) + "." + type;
            File file = new File(localPath);
            // 将image 流写入文件
            ImageIO.write(image, type, file);
            if (file.exists()) {
                // 也是因为目前如果一个用户上传 pdf 成功之后到算法解析完成之前都是不允许再次上传的 所以不会出现目录不存在的问题，
                // 但是如果支持并发上传就会出现目录不存在问题。
                boolean exists = SftpUtils.directoryExists(channelSftp, algFilePath);
                if (!exists) {
                    SftpUtils.mkdirDirs(algFilePath, channelSftp);
                }

                // 文件服务器图片路径
                if (Objects.nonNull(modeId) && StrUtil.isNotBlank(modeId.toString())) {
                    boolean modelIdexists = SftpUtils.directoryExists(channelSftp, remoteAlgModelIdPath);
                    if (!modelIdexists) {
                        SftpUtils.mkdirDirs(remoteAlgModelIdPath, channelSftp);
                    }
                    channelSftp.put(localPath, remoteAlgModelIdFilename);
                } else {
                    channelSftp.put(localPath, remoteAlgFilename);
                }
                boolean delete = FileUtil.del(file);
                if (delete) {
                    log.info("文献{}的id为{}的第{}张算法画四角坐标解析完成并且删除成功", paperId, id, page);
                } else {
                    log.info("本地图片删除失败,路径{}", localPath);
                }
            }
        } catch (SftpException e) {
            log.error(e.getMessage(), e);
            log.error("两人同时上传的时候第二个人会把第一个人的删除  第一个人 获取的时候就是 null  no such file ");
        }
    }


    private void echoData(String id, JSONObject result) {
        Condition condition;
        condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.nonNull(condition)) {
            PaperPICOConditionDTO paperPICOCondition = condition.getPaperPICOConditionDTO();
            PaperModelConditionDTO paperModelCondition = condition.getPaperModelConditionDTO();
            if (Objects.isNull(paperModelCondition)) {
                if (Objects.nonNull(paperPICOCondition)) {
                    result.put("PaperPICOCondition", paperPICOCondition);
                }
            } else {
                if (Objects.isNull(paperPICOCondition)) {
                    result.put("PaperModelCondition", paperModelCondition);
                } else {
                    // 都使用过需要判断一下 那个是最新的
                    Long picoUpdateTime = paperPICOCondition.getUpdateTime();
                    Long modelUpdateTime = paperModelCondition.getUpdateTime();
                    if (picoUpdateTime > modelUpdateTime) {
                        result.put("PaperPICOCondition", paperPICOCondition);
                    } else {
                        result.put("PaperModelCondition", paperModelCondition);
                    }
                }
            }
        }
    }
    
    /***
     * 修复es中缺失标点符号问题
     * 美化高亮 1 禁止停用词高亮 2 当存在较长的高亮时取出单个字符的高亮
     * @param highTarget 原文
     * @param highResult es检索后高亮
     * @param condition 检索条件
     * @param search 二次检索高亮显示
     * @return 修复后的摘要显示
     */
    public String highLight(String highTarget, String highResult, Condition condition, String search) {
        //获取药品+参比药物的集合
        Set<String> drugSet = new HashSet<>();
        //获取疾病+结局指标的集合
        Set<String> diseaseSet = new HashSet<>();

        ConditionLiteratureAlter conditionLiteratureAlter = condition.getConditionLiteratureAlter();
        List<Drug> drugs = condition.getDrugs();
        List<InterventionAndOutcome> interventions = condition.getInterventions();
        List<Disease> diseases = condition.getDiseases();
        // 去定语之后的
        List<Disease> literatureWipeDiseases = condition.getLiteratureWipeDiseases();
        // 结局指标
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        if (Objects.nonNull(conditionLiteratureAlter)) {
            drugs = conditionLiteratureAlter.getDrugs();
            interventions = conditionLiteratureAlter.getInterventions();
            diseases = conditionLiteratureAlter.getDiseases();
            outcomes = conditionLiteratureAlter.getOutcomes();
            literatureWipeDiseases = conditionLiteratureAlter.getLiteratureWipeDiseases();
        }

        JSONArray array = new JSONArray();
        array.add(drugs);
        if (CollUtil.isNotEmpty(interventions)) {
            array.add(interventions);
        }
        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollUtil.isNotEmpty(innerArr)) {
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject json = innerArr.getJSONObject(i1);
                    Integer status = json.getInteger("status");
                    if (status == 1) {
                        String word = json.getString("word").toLowerCase();
                        drugSet.add(word.toLowerCase());
                        drugSet.add(word);

                        String enWord = json.getString("enWord");
                        if (StringUtils.isNotBlank(enWord)) {
                            drugSet.add(enWord.toLowerCase());
                        }

                        JSONArray enSynonym = json.getJSONArray("enSynonym");
                        if (CollUtil.isNotEmpty(enSynonym)) {
                            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    drugSet.add(name);
                                }
                            }
                        }

                        String zhWord = json.getString("zhWord");
                        if (StringUtils.isNotBlank(zhWord)) {
                            drugSet.add(zhWord.toLowerCase());
                        }

                        JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                        if (CollUtil.isNotEmpty(zhSynonym)) {
                            for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    drugSet.add(name);
                                }
                            }
                        }

                        JSONArray otherSynonym = json.getJSONArray("otherSynonym");
                        if (CollUtil.isNotEmpty(otherSynonym)){
                            for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    drugSet.add(name);
                                }
                            }
                        }

                        //补充同义词
                        String expandSynonym = json.getString("expandSynonym");
                        if (StrUtil.isNotBlank(expandSynonym)) {
                            expandSynonym = expandSynonym.replaceAll("；", ";");
                            String[] split = expandSynonym.split(";");
                            for (String txt : split) {
                                if (StringUtils.isNotBlank(txt)) {
                                    drugSet.add(txt.toLowerCase());
                                }
                            }
                        }

                        // 增加商品名
                        JSONArray commodityNames = json.getJSONArray("commodityNames");
                        if (CollUtil.isNotEmpty(commodityNames)) {
                            List<String> collect = commodityNames.stream().map(String::valueOf).collect(Collectors.toList());
                            collect = collect.stream().distinct().collect(Collectors.toList());
                            drugSet.addAll(collect);
                        }

                        // 药品表中 五级同义词
                        JSONArray zhDrugNames = json.getJSONArray("zhDrugNames");
                        if (CollUtil.isNotEmpty(zhDrugNames)) {
                            drugSet.addAll(zhDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                        }
                        JSONArray enDrugNames = json.getJSONArray("enDrugNames");
                        if (CollUtil.isNotEmpty(enDrugNames)) {
                            drugSet.addAll(enDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                        }
                    }
                }
            }
        }
        JSONArray otherArray = new JSONArray();
        if (CollUtil.isNotEmpty(diseases)) {
            otherArray.add(diseases);
        }

        if (CollUtil.isNotEmpty(outcomes)) {
            otherArray.add(outcomes);
        }
        int wipeDiseaseSize = 0;
        for (int i = 0; i < otherArray.size(); i++) {
            JSONArray innerArr = otherArray.getJSONArray(i);
            if (CollUtil.isNotEmpty(innerArr)) {
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject json = innerArr.getJSONObject(i1);
                    Integer status = json.getInteger("status");
                    if (status == 1) {
                        String word = json.getString("word").toLowerCase();
                        diseaseSet.add(word);

                        String enWord = json.getString("enWord");
                        if (StringUtils.isNotBlank(enWord)) {
                            diseaseSet.add(enWord.toLowerCase());
                        }

                        JSONArray enSynonym = json.getJSONArray("enSynonym");
                        if (CollUtil.isNotEmpty(enSynonym)) {
                            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    diseaseSet.add(name);
                                }
                            }
                        }

                        String zhWord = json.getString("zhWord");
                        if (StringUtils.isNotBlank(zhWord)) {
                            diseaseSet.add(zhWord.toLowerCase());
                        }

                        JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                        if (CollUtil.isNotEmpty(zhSynonym)) {
                            for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    diseaseSet.add(name);
                                }
                            }
                        }

                        JSONArray otherSynonym = json.getJSONArray("otherSynonym");
                        if (CollUtil.isNotEmpty(otherSynonym)){
                            for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    diseaseSet.add(name);
                                }
                            }
                        }

                        //补充同义词
                        String expandSynonym = json.getString("expandSynonym");
                        if (StrUtil.isNotBlank(expandSynonym)) {
                            expandSynonym = expandSynonym.replaceAll("；", ";");
                            String[] split = expandSynonym.split(";");
                            for (String txt : split) {
                                if (StringUtils.isNotBlank(txt)) {
                                    diseaseSet.add(txt.toLowerCase());
                                }
                            }
                        }

                        try {
                            Disease disease = literatureWipeDiseases.get(wipeDiseaseSize++);

                            String word_ = disease.getWord();
                            diseaseSet.add(word_.toLowerCase());
                            diseaseSet.add(word_);

                            String enWord_ = disease.getEnWord();
                            if (StringUtils.isNotBlank(enWord_)){
                                diseaseSet.add(enWord_.toLowerCase());
                                diseaseSet.add(enWord_);
                            }

                            List<WordStatus> enSynonym_ = disease.getEnSynonym();
                            if (CollUtil.isNotEmpty(enSynonym_)){
                                for (WordStatus wordStatus : enSynonym_) {
                                    String name = wordStatus.getName();
                                    Boolean checked = wordStatus.getChecked();
                                    if (checked) {
                                        diseaseSet.add(name.toLowerCase());
                                        diseaseSet.add(name);
                                    }
                                }
                            }

                            String zhWord_ = disease.getZhWord();
                            if (StringUtils.isNotBlank(zhWord_)){
                                diseaseSet.add(zhWord_.toLowerCase());
                                diseaseSet.add(zhWord_);
                            }

                            List<WordStatus> zhSynonym_ = disease.getZhSynonym();
                            if (CollUtil.isNotEmpty(zhSynonym_)){
                                for (WordStatus wordStatus : zhSynonym_) {
                                    String name = wordStatus.getName();
                                    Boolean checked = wordStatus.getChecked();
                                    if (checked) {
                                        diseaseSet.add(name.toLowerCase());
                                        diseaseSet.add(name);
                                    }
                                }
                            }

                            List<WordStatus> otherSynonym_ = disease.getOtherSynonym();
                            if (CollUtil.isNotEmpty(otherSynonym_)){
                                for (WordStatus wordStatus : otherSynonym_) {
                                    String name = wordStatus.getName();
                                    Boolean checked = wordStatus.getChecked();
                                    if (checked) {
                                        diseaseSet.add(name.toLowerCase());
                                        diseaseSet.add(name);
                                    }
                                }
                            }
                        } catch (Exception e) {
                            log.error("结局指标没有去定语!!!");
                        }
                    }
                }
            }
        }
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
            for (String s1 : diseaseSet) {
                if (s1.length() == 1) {
                    continue;
                }
                if (s.toLowerCase().contains(s1.toLowerCase())) {
                    pre = "<i>";
                    tag = "</i>";
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


}
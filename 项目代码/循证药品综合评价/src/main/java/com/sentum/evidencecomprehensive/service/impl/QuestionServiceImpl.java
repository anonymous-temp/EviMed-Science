package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateTime;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.lang.Snowflake;
import cn.hutool.core.util.StrUtil;
import cn.hutool.core.util.ZipUtil;
import cn.hutool.extra.servlet.ServletUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.itextpdf.text.Font;
import com.itextpdf.text.Image;
import com.itextpdf.text.*;
import com.itextpdf.text.pdf.BaseFont;
import com.itextpdf.text.pdf.PdfPCell;
import com.itextpdf.text.pdf.PdfPTable;
import com.itextpdf.text.pdf.PdfWriter;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.constants.EvimedPdfFont;
import com.sentum.evidencecomprehensive.domain.es.GuideIndex;
import com.sentum.evidencecomprehensive.domain.mongo.*;
import com.sentum.evidencecomprehensive.excel.ClinicalBo;
import com.sentum.evidencecomprehensive.excel.bean.*;
import com.sentum.evidencecomprehensive.excel.converter.*;
import com.sentum.evidencecomprehensive.excel.pdf.MyHeaderFooter;
import com.sentum.evidencecomprehensive.exception.BizException;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.feign.SystemFeign;
import com.sentum.evidencecomprehensive.domain.dto.EvidenceBasedReport;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.QuestionVo;
import com.sentum.evidencecomprehensive.service.MailService;
import com.sentum.evidencecomprehensive.service.QuestionService;
import com.sentum.evidencecomprehensive.utils.CommonUtil;
import com.sentum.evidencecomprehensive.utils.ExcelResponseUtil;
import com.sentum.evidencecomprehensive.utils.FormatUtil;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import com.sentum.evidencecomprehensive.utils.operateyl.RedisUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.BeansException;
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
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.awt.*;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.List;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
public class QuestionServiceImpl implements QuestionService {
    
    private final MailService mailService;
    private final MongoTemplate mongoTemplate;
    private final ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private SystemFeign systemFeign;
    @Autowired
    private JdbcTemplate jdbcTemplate;
    @Autowired
    private FineScreenFeign fineScreenFeign;
    
    @Value("${local.excel.path}")
    private String localExcelPath;
    private static final int MAX_WIDTH = 520;

    public QuestionServiceImpl(MailService mailService, MongoTemplate mongoTemplate, ElasticsearchRestTemplate elasticsearchRestTemplate) {
        this.mailService = mailService;
        this.mongoTemplate = mongoTemplate;
        this.elasticsearchRestTemplate = elasticsearchRestTemplate;
    }

    @Override
    public String create(String id, Long userId, HttpServletRequest request) {
        Question question = new Question();
        question.setId(id);
        question.setUserId(userId);
        question.setCreateUserId(userId);
        StringBuilder name = new StringBuilder();
        
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition != null) {
            //药品
            List<Drug> drugs = condition.getDrugs();
            if (CollUtil.isNotEmpty(drugs)){
                for (Drug drug : drugs) {
                    Integer status = drug.getStatus();
                    if (status == 1){
                        name.append(drug.getWord());
                    } else if (status == 2){
                        //与
                        name.append("联合");
                    }else {
                        //非
                        name.append("排除");
                    }
                }
            }
            //疾病
            List<Disease> diseases = condition.getDiseases();
            if (CollUtil.isNotEmpty(diseases)){
                if (CollUtil.isNotEmpty(drugs)) {
                    name.append("治疗");
                }
                for (Disease disease : diseases) {
                    Integer status = disease.getStatus();
                    if (status == 1){
                        name.append(disease.getWord());
                    }else if (status == 2){
                        //与
                        name.append("合并");
                    }else {
                        //非
                        name.append("排除");
                    }
                }
            }
        }
        question.setName(name.toString());
        
        long timeMillis = System.currentTimeMillis();
        question.setCreateTime(timeMillis);
        question.setUpdateTime(timeMillis);
        question.setPId("-1");
        question.setHistoryNum(0);
        
        //判断是超说明书还是循证、中兴
        question.setType(belongTo(request));
        try {
            mongoTemplate.save(question);
        } catch (Exception e) {
            e.printStackTrace();
        }
        //创建站内信
        return mailService.create(id, userId);
    }

    @Override
    public Boolean updateName(String id, String name) {
        Update update = new Update();
        update.set("name", name);
        update.set("updateTime", System.currentTimeMillis());
        UpdateResult updateResult = mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(id)), update, Question.class);
        return updateResult.getMatchedCount() > 0;
    }

    @Override
    public String getName(String id) {
        Question question = mongoTemplate.findById(id, Question.class);
        if (question != null){
            return question.getName();
        }
        return null;
    }

    @Override
    public PageVo<QuestionVo> list(Long userId, Integer type, String search, Integer pageSize, Integer pageNum, Integer sortType, Integer direction, HttpServletRequest request) {
        //1-全部课题；2-我的课题；3-收藏课题；4-分享课题
        List<Criteria> criteriaList = new ArrayList<>();
        switch (type) {
            case 1:
                criteriaList.add(Criteria.where("userId").is(userId));
                break;
            case 2:
                criteriaList.add(Criteria.where("createUserId").is(userId));
                break;
            case 3:
                criteriaList.add(Criteria.where("userId").is(userId));
                criteriaList.add(Criteria.where("collectStatus").is(1));
                break;
            case 4:
                criteriaList.add(Criteria.where("userId").is(userId));
                criteriaList.add(Criteria.where("createUserId").ne(userId));
                break;
            default:
                criteriaList.add(Criteria.where("userId").is(userId));
                break;
        }
        if (StringUtils.isNotBlank(search)){
            criteriaList.add(Criteria.where("name").regex(search, "i"));
        }
        //判断是超说明书还是循证、中兴
        criteriaList.add(Criteria.where("type").is(belongTo(request)));
        criteriaList.add(Criteria.where("pId").is("-1"));
        Criteria criteria = new Criteria();
        criteria.andOperator(criteriaList.toArray(new Criteria[0]));
        Query query = new Query(criteria);
        long total = mongoTemplate.count(query, Question.class);
        int pages = (int) (total % pageSize == 0 ? total / pageSize : total / pageSize + 1);
        query.with(PageRequest.of(pageNum - 1, pageSize));
        String sortName = "";
        if (sortType == 1) {
            sortName = "createTime";
        } else if (sortType == 2) {
            sortName = "updateTime";
        } else {
            //默认顺序按照创建时间倒叙
            query.with(Sort.by(Sort.Direction.DESC, "createTime"));
        }
        if (StringUtils.isNotBlank(sortName)) {
            if (direction == 1) {
                query.with(Sort.by(Sort.Direction.ASC, sortName));
            } else {
                query.with(Sort.by(Sort.Direction.DESC, sortName));
            }
        }
        List<Question> questions = mongoTemplate.find(query, Question.class);
        List<QuestionVo> list = new ArrayList<>();
        questions.forEach(question -> {
            QuestionVo questionVo = FormatUtil.formQuestion(question);
            //获得创建人用户名
            Long createUserId = question.getCreateUserId();
            String userInfo = "";
            try {
                userInfo = systemFeign.userInfo();
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            String createName = "";
            if (StringUtils.isNotBlank(userInfo)){
                JSONObject parseObject = JSONObject.parseObject(userInfo);
                Integer code = parseObject.getInteger("code");
                if (code == 200) {
                    JSONObject data = parseObject.getJSONObject("data");
                    String accountName = data.getString("accountName");
                    if (StringUtils.isBlank(accountName)) {
                        accountName = data.getString("userName");
                    }
                    if (StringUtils.isNotBlank(accountName)) {
                        createName = accountName;
                    }
                }
            }
            questionVo.setCreateName(createName);
            //判断课题是否进去详情页
            Integer historyNum = question.getHistoryNum();
            questionVo.setStatus(0);
            if (historyNum > 0){
                questionVo.setStatus(1);
            }
            list.add(questionVo);
        });
        list.forEach((questionVo) -> {
            String id = questionVo.getId();
            try {
                ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
//            JSONObject evidenceBasedReport = mongoTemplate.findById(id, JSONObject.class, "evidence_based_report");
                questionVo.setExists(!Objects.isNull(reportContent));
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        });
        PageVo<QuestionVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(total);
        page.setPages(pages);
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        return page;
    }

    @Override
    public Boolean delete(List<String> ids) {
        try {
            List<String> allIds = new ArrayList<>(ids);
            List<Condition> conditions = mongoTemplate.find(new Query(Criteria.where("pId").in(ids)), Condition.class);
            for (Condition condition : conditions) {
                allIds.add(condition.getId());
            }
            //删除当前课题及其历史记录
            mongoTemplate.remove(new Query(Criteria.where("_id").in(allIds)), Question.class);
            //删除检索条件及其历史记录
            mongoTemplate.remove(new Query(Criteria.where("_id").in(allIds)), Condition.class);
            //删除文献质量修改
            mongoTemplate.remove(new Query(Criteria.where("conditionId").in(allIds)), PaperQuality.class);
            //删除文献纳排
            mongoTemplate.remove(new Query(Criteria.where("conditionId").in(allIds)), PaperIncludeOrExclude.class);
            //复制指南纳排
            mongoTemplate.remove(new Query(Criteria.where("conditionId").in(allIds)), GuideIncludeOrExclude.class);
            //复制临床试验纳排
            mongoTemplate.remove(new Query(Criteria.where("conditionId").in(allIds)), ClinicalTrialsIncludeOrExclude.class);
            return true;
        } catch (Exception e) {
            e.printStackTrace();
        }
        return false;
    }

    @Override
    public Boolean collect(List<String> ids, Integer status) {
        Update update = new Update();
        update.set("collectStatus", status);
        UpdateResult updateResult = mongoTemplate.updateMulti(new Query(Criteria.where("_id").in(ids)), update, Question.class);
        return updateResult.getMatchedCount() > 0;
    }

    @Override
    public Boolean insertHistory(String id) {
        Question pQuestion = mongoTemplate.findById(id, Question.class);
        if (pQuestion != null) {
            Question question = new Question();
            String pId = pQuestion.getPId();
            if ("-1".equals(pId)) {
                pId = id;
            }
            BeanUtils.copyProperties(pQuestion, question);
            question.setPId(pId);
            String newId = UUID.randomUUID().toString();
            question.setId(newId);
            long timeMillis = System.currentTimeMillis();
            question.setUpdateTime(timeMillis);
            question.setCreateTime(timeMillis);
            //question.setUserId(question.getUserId());
            //question.setCreateUserId(question.getUserId());
            question.setCollectStatus(question.getCollectStatus());
            String name = pQuestion.getName();
            Integer historyNum = pQuestion.getHistoryNum();
            question.setName(name + "-" + historyNum);
            //将原来数据的historyNum+1
            historyNum = historyNum + 1;
            question.setHistoryNum(historyNum);
            Update update = new Update();
            update.set("historyNum", historyNum);
            try {
                mongoTemplate.save(question);
                mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(id)), update, Question.class);
                //只保留最新的3个历史记录
                List<Question> questions = mongoTemplate.find(new Query(Criteria.where("pId").is(pId)).with(Sort.by(Sort.Direction.DESC, "updateTime")), Question.class);
                if (questions.size() > 3) {
                    List<String> deleteIds = new ArrayList<>();
                    for (int i = 3; i < questions.size(); i++) {
                        deleteIds.add(questions.get(i).getId());
                    }
                    mongoTemplate.remove(new Query(Criteria.where("_id").in(deleteIds)), Question.class);
                }
                //复制新的检索条件表
                Condition pCondition = mongoTemplate.findById(id, Condition.class);
                if (pCondition != null) {
                    Condition condition = new Condition();
                    BeanUtils.copyProperties(pCondition, condition);
                    condition.setId(newId);
                    mongoTemplate.save(condition);
                }
                Query query = new Query(Criteria.where("conditionId").is(id));
                //复制文献质量修改
                List<PaperQuality> paperQualities = mongoTemplate.find(query, PaperQuality.class);
                if (CollUtil.isNotEmpty(paperQualities)) {
                    List<PaperQuality> newPaperQualities = new ArrayList<>();
                    paperQualities.forEach(paperQuality -> {
                        paperQuality.setId(UUID.randomUUID().toString());
                        paperQuality.setConditionId(newId);
                        newPaperQualities.add(paperQuality);
                    });
                    mongoTemplate.insert(newPaperQualities, PaperQuality.class);
                }
                //复制文献纳排
                List<PaperIncludeOrExclude> includeOrExcludeList = mongoTemplate.find(query, PaperIncludeOrExclude.class);
                if (CollUtil.isNotEmpty(includeOrExcludeList)){
                    List<PaperIncludeOrExclude> newIncludeOrExcludeList = new ArrayList<>();
                    includeOrExcludeList.forEach(paperIncludeOrExclude -> {
                        paperIncludeOrExclude.setId(UUID.randomUUID().toString());
                        paperIncludeOrExclude.setConditionId(newId);
                        newIncludeOrExcludeList.add(paperIncludeOrExclude);
                    });
                    mongoTemplate.insert(newIncludeOrExcludeList, PaperIncludeOrExclude.class);
                }
                //复制指南纳排
                List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(query, GuideIncludeOrExclude.class);
                if (CollUtil.isNotEmpty(guideIncludeOrExcludes)) {
                    List<GuideIncludeOrExclude> newGuideIncludeOrExcludes = new ArrayList<>();
                    guideIncludeOrExcludes.forEach(guideIncludeOrExclude -> {
                        guideIncludeOrExclude.setId(UUID.randomUUID().toString());
                        guideIncludeOrExclude.setConditionId(newId);
                        newGuideIncludeOrExcludes.add(guideIncludeOrExclude);
                    });
                    mongoTemplate.insert(newGuideIncludeOrExcludes, GuideIncludeOrExclude.class);
                }
                //复制临床试验纳排
                List<ClinicalTrialsIncludeOrExclude> clinicalTrialsIncludeOrExcludes = mongoTemplate.find(query, ClinicalTrialsIncludeOrExclude.class);
                if (CollUtil.isNotEmpty(clinicalTrialsIncludeOrExcludes)) {
                    List<ClinicalTrialsIncludeOrExclude> newClinicalTrialsIncludeOrExcludes = new ArrayList<>();
                    clinicalTrialsIncludeOrExcludes.forEach(clinicalTrialsIncludeOrExclude -> {
                        clinicalTrialsIncludeOrExclude.setId(UUID.randomUUID().toString());
                        clinicalTrialsIncludeOrExclude.setConditionId(newId);
                        newClinicalTrialsIncludeOrExcludes.add(clinicalTrialsIncludeOrExclude);
                    });
                    mongoTemplate.insert(newClinicalTrialsIncludeOrExcludes, ClinicalTrialsIncludeOrExclude.class);
                }
                //复制报告
                EvidenceBasedReport evidenceBasedReport = mongoTemplate.findById(id, EvidenceBasedReport.class, "evidence_based_report");
                if (evidenceBasedReport != null) {
                    evidenceBasedReport.setId(newId);
                    mongoTemplate.save(evidenceBasedReport, "evidence_based_report");
                }
                //复制超说明书报告
                JSONObject evidence_based_report = mongoTemplate.findById(id, JSONObject.class, "evidence_based_report");
                if (evidence_based_report != null) {
                    evidence_based_report.put("_id", newId);
                    mongoTemplate.save(evidence_based_report, "evidence_based_report");
                }
                return true;
            } catch (BeansException e) {
                e.printStackTrace();
            }
        }
        return false;
    }

    @Override
    public List<QuestionVo> history(String id) {
        List<QuestionVo> list = new ArrayList<>();
        List<Question> questions = mongoTemplate.find(new Query(Criteria.where("pId").is(id)).with(Sort.by(Sort.Direction.DESC, "updateTime")), Question.class);
        questions.forEach(question -> list.add(FormatUtil.formQuestion(question)));
        return list;
    }

    @Override
    public String createShareUrl(String id, Long userId) {
        return "?share=" + id + "&userId=" + userId;
    }

    @Override
    public Boolean share(String tarId, Long tarUserId, Long userId, HttpServletRequest request) {
        Question tarQuestion = mongoTemplate.findById(tarId, Question.class);
        if (tarQuestion != null) {
            Query questionQuery = new Query(Criteria.where("tarId").is(tarId).and("userId").is(userId));
            questionQuery.with(PageRequest.of(0, 1, Sort.by(Sort.Direction.DESC, "createTime")));
            Question one = mongoTemplate.findOne(questionQuery, Question.class);
            String name = tarQuestion.getName();
            if (one != null) {
                //name = one.getName();
                return false;
            }
            Question question = new Question();
            String newId = UUID.randomUUID().toString();
            question.setId(newId);
            question.setTarId(tarId);
            question.setCreateUserId(tarUserId);
            question.setUserId(userId);
            question.setPId("-1");
            question.setCollectStatus(0);
            long currentTimeMillis = System.currentTimeMillis();
            question.setCreateTime(currentTimeMillis);
            question.setUpdateTime(currentTimeMillis);
            question.setName(name + "-copy");
            question.setHistoryNum(0);
            //判断是超说明书还是循证、中兴
            question.setType(belongTo(request));
            mongoTemplate.save(question);
            //复制新的检索条件表
            Condition pCondition = mongoTemplate.findById(tarId, Condition.class);
            if (pCondition != null) {
                Condition condition = new Condition();
                BeanUtils.copyProperties(pCondition, condition);
                condition.setId(newId);
                mongoTemplate.save(condition);
            }
            Query query = new Query(Criteria.where("conditionId").is(tarId));
            //复制文献质量修改
            List<PaperQuality> paperQualities = mongoTemplate.find(query, PaperQuality.class);
            if (CollUtil.isNotEmpty(paperQualities)) {
                List<PaperQuality> newPaperQualities = new ArrayList<>();
                paperQualities.forEach(paperQuality -> {
                    paperQuality.setId(UUID.randomUUID().toString());
                    paperQuality.setConditionId(newId);
                    paperQuality.setUserId(userId);
                    newPaperQualities.add(paperQuality);
                });
                mongoTemplate.insert(newPaperQualities, PaperQuality.class);
            }
            //复制文献纳排
            List<PaperIncludeOrExclude> includeOrExcludeList = mongoTemplate.find(query, PaperIncludeOrExclude.class);
            if (CollUtil.isNotEmpty(includeOrExcludeList)){
                List<PaperIncludeOrExclude> newIncludeOrExcludeList = new ArrayList<>();
                includeOrExcludeList.forEach(paperIncludeOrExclude -> {
                    paperIncludeOrExclude.setId(UUID.randomUUID().toString());
                    paperIncludeOrExclude.setConditionId(newId);
                    paperIncludeOrExclude.setUserId(userId);
                    newIncludeOrExcludeList.add(paperIncludeOrExclude);
                });
                mongoTemplate.insert(newIncludeOrExcludeList, PaperIncludeOrExclude.class);
            }
            //复制指南纳排
            List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(query, GuideIncludeOrExclude.class);
            if (CollUtil.isNotEmpty(guideIncludeOrExcludes)) {
                List<GuideIncludeOrExclude> newGuideIncludeOrExcludes = new ArrayList<>();
                guideIncludeOrExcludes.forEach(guideIncludeOrExclude -> {
                    guideIncludeOrExclude.setId(UUID.randomUUID().toString());
                    guideIncludeOrExclude.setConditionId(newId);
                    guideIncludeOrExclude.setUserId(userId);
                    newGuideIncludeOrExcludes.add(guideIncludeOrExclude);
                });
                mongoTemplate.insert(newGuideIncludeOrExcludes, GuideIncludeOrExclude.class);
            }
            //复制临床试验纳排
            List<ClinicalTrialsIncludeOrExclude> clinicalTrialsIncludeOrExcludes = mongoTemplate.find(query, ClinicalTrialsIncludeOrExclude.class);
            if (CollUtil.isNotEmpty(clinicalTrialsIncludeOrExcludes)) {
                List<ClinicalTrialsIncludeOrExclude> newClinicalTrialsIncludeOrExcludes = new ArrayList<>();
                clinicalTrialsIncludeOrExcludes.forEach(clinicalTrialsIncludeOrExclude -> {
                    clinicalTrialsIncludeOrExclude.setId(UUID.randomUUID().toString());
                    clinicalTrialsIncludeOrExclude.setConditionId(newId);
                    clinicalTrialsIncludeOrExclude.setUserId(userId);
                    newClinicalTrialsIncludeOrExcludes.add(clinicalTrialsIncludeOrExclude);
                });
                mongoTemplate.insert(newClinicalTrialsIncludeOrExcludes, ClinicalTrialsIncludeOrExclude.class);
            }
            //复制报告
            JSONObject evidenceBasedReport = mongoTemplate.findById(tarId, JSONObject.class, "evidence_based_report");
            if (evidenceBasedReport != null) {
                evidenceBasedReport.put("_id", newId);
                mongoTemplate.save(evidenceBasedReport, "evidence_based_report");
            }
            return true;
        }
        return false;
    }

    @Override
    public Integer determine(String id) {
        return 2;
//        EvidenceBasedReport basedReport = mongoTemplate.findById(id, EvidenceBasedReport.class, "evidence_based_report");
//        if (basedReport != null) {
//            return 2;
//        }
//        return 1;
    }

    /**
     * 判断当前课题属于哪个平台 1-超说明书；2-循证综合评价；3-中兴
     * @param request 请求
     * @return 1-超说明书；2-循证综合评价；3-中兴
     */
    private Integer belongTo(HttpServletRequest request) {
        int typeFlag = 2;
        if (Objects.nonNull(request)) {
            //超说明书
            List<String> offlabel = new ArrayList<>(Arrays.asList("http://192.168.20.252:2032/", "https://syshospital-offlabel.evimed.com/", "http://syshospital-offlabel.evimed.com/"));
            //中兴循证
            //List<String> zwhta = new ArrayList<>(Arrays.asList("http://192.168.20.252:2027/", "https://zwhta.evimed.com/", "http://zwhta.evimed.com/"));
            //evimed循证
            List<String> evimedOfflabel = new ArrayList<>(Arrays.asList("http://192.168.20.252:2028/", "https://syshospital.evimed.com/", "http://syshospital.evimed.com/"));
            String referer = request.getHeader("referer");
            if (StringUtils.isBlank(referer)) {
                referer = request.getHeader("origin");
            }
            if (StrUtil.isNotBlank(referer)) {
                if (referer.contains("?")) {
                    String[] split = referer.split("\\?");
                    referer = split[0];
                }

                for (String s : offlabel) {
                    if (referer.contains(s)){
                        typeFlag = 1;
                        break;
                    }
                }
            }
        }
        
        return typeFlag;
    }

    @Override
    public List<Question> getByIds(List<String> idList) {
        if (CollUtil.isNotEmpty(idList)) {
            return mongoTemplate.find(new Query(Criteria.where("id").in(idList)), Question.class);
        }
        return null;
    }

    @Override
    public void download(String ids, String types, HttpServletResponse response) {
        List<String> idList = Arrays.stream(ids.split(",")).collect(Collectors.toList());
        List<String> downloadType = Arrays.asList(types.split(","));
        if (idList.size() > 11) {
            throw new BizException(500, "单次下载不能超过10个课题");
        }
        List<Question> questions = getByIds(idList);
        // 
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyyMMdd", Locale.CHINA);
        if (CollUtil.isNotEmpty(questions)) {
            // userid 雪花算法生成
            Snowflake snowflake = new Snowflake();
            String idStr = snowflake.nextIdStr();
            for (Question question : questions) {
                String id = question.getId();
                String name = question.getName();
                // 下载路径
                String tempFilePath = CommonUtil.removeSeparatorFromSuffix(localExcelPath).concat(Constants.PAD_LEFT_SLASH).concat(idStr)
                        .concat(Constants.PAD_LEFT_SLASH).concat(name.concat("-").concat(simpleDateFormat.format(new DateTime()))).concat(Constants.PAD_LEFT_SLASH);
                
                if (downloadType.contains("1")) {
                    // 先创建文件夹
                    String paperTempFilePath = tempFilePath;
                    paperTempFilePath = CommonUtil.removeSeparatorFromSuffix(paperTempFilePath.concat(Constants.EXCEL_FILE_PATH_PAPER)).concat(Constants.PAD_LEFT_SLASH);
                    if (!FileUtil.exist(paperTempFilePath)) {
                        FileUtil.mkParentDirs(paperTempFilePath);
                        FileUtil.mkdir(paperTempFilePath);
                    }
                    // 文献
                    List<PaperIncludeOrExclude> paperIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);
                    List<String> paperIds = paperIncludeOrExcludes.stream().map(PaperIncludeOrExclude::getPaperId).collect(Collectors.toList());
                    List<MongoLiterature> mongoLiteratures = new ArrayList<>();
                    for (String paperId : paperIds) {
                        MongoLiterature mongoLiterature = fineScreenFeign.paper(paperId);
//                        MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("_id").in(paperId)), MongoLiterature.class, "mongo_literature_" + Math.abs(paperId.hashCode()) % 10);
                        assert mongoLiterature != null;
                        List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
                        List<String> journalDivision = mongoLiterature.getJournalDivision();
                        String language = mongoLiterature.getLanguage();
                        if (StrUtil.isNotBlank(language) 
                                && "zh".equals(language) 
                                && Objects.nonNull(recognizedKernelJournals) 
                                && CollUtil.isNotEmpty(recognizedKernelJournals)) {
                            List<String> zhKerJournals = new ArrayList<>();
                            if (recognizedKernelJournals.contains("Peking University")) {
                                zhKerJournals.add("北大核心");
                            }
                            if (recognizedKernelJournals.contains("Technology")) {
                                zhKerJournals.add("科技核心");
                            }
                            if (recognizedKernelJournals.contains("Nanjing University")) {
                                zhKerJournals.add("南大核心");
                            }
                            mongoLiterature.setRecognizedKernelJournals(zhKerJournals);
                        }
//                        if (StrUtil.isNotBlank(language)
//                                && "en".equals(language)
//                                && Objects.nonNull(journalDivision)
//                                && CollUtil.isNotEmpty(journalDivision)) {
//                            List<String> enKerJournals = new ArrayList<>();
//                            if (recognizedKernelJournals.contains("Peking University")) {
//                                enKerJournals.add("北大核心");
//                            }
//                            if (recognizedKernelJournals.contains("Technology")) {
//                                enKerJournals.add("科技核心");
//                            }
//                            if (recognizedKernelJournals.contains("Nanjing University")) {
//                                enKerJournals.add("南大核心");
//                            }
//                            mongoLiterature.setJournalDivision(enKerJournals);
//                        }
                        mongoLiteratures.add(mongoLiterature);
                    }
                    List<BaseExcelExportBean> paperExcelExportBeanList = new ArrayList<>();
                    // 分批处理文献
                    batchGetDataForExcel(mongoLiteratures, paperExcelExportBeanList, 1);
                    try {
                        ExcelResponseUtil.buildExcelFile(PaperExcelExportBean.class, paperExcelExportBeanList, question.getName(), 1, "文献", simpleDateFormat, paperTempFilePath);
                    } catch (IOException e) {
                        log.error(e.getMessage(), e);
                    }
                }
                if (downloadType.contains("2")) {
                    String guideTempFilePath = tempFilePath;
                    guideTempFilePath = CommonUtil.removeSeparatorFromSuffix(guideTempFilePath.concat(Constants.EXCEL_FILE_PATH_GUIDE)).concat(Constants.PAD_LEFT_SLASH);
                    if (!FileUtil.exist(guideTempFilePath)) {
                        FileUtil.mkParentDirs(guideTempFilePath);
                        FileUtil.mkdir(guideTempFilePath);
                    }
                    // 指南
                    List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), GuideIncludeOrExclude.class);
                    BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
//                // 筛选五年内的指南
//                DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
//                LocalDate now = LocalDate.now();
//                LocalDate fiveYearsAgo = now.minus(Period.ofYears(5));
//                String startDate = fiveYearsAgo.format(formatter);
//                String endDate = now.format(formatter);
//                boolQueryBuilder.must().add(QueryBuilders.rangeQuery("fbdate").from(startDate).to(endDate));
                    // 收录被纳入的指南id
                    boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(guideIncludeOrExcludes.stream().map(GuideIncludeOrExclude::getGuideId).toArray(String[]::new)));
                    NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
                    nativeSearchQuery.setTrackTotalHits(true);
                    SearchHits<GuideIndex> guideIndexSearchHits = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
                    List<GuideIndex> guides = new ArrayList<>();
                    if (guideIndexSearchHits.getTotalHits() > 0) {
                        guides = guideIndexSearchHits.stream().map(SearchHit::getContent).collect(Collectors.toList());
                    }
                    List<BaseExcelExportBean> guideExcelExportBeanList = new ArrayList<>();
                    // 分批处理指南
                    batchGetDataForExcel(guides, guideExcelExportBeanList,  2);
                    try {
                        ExcelResponseUtil.buildExcelFile(GuideExcelExportBean.class, guideExcelExportBeanList, question.getName(), 2, "指南", simpleDateFormat, guideTempFilePath);
                    } catch (IOException e) {
                        log.error(e.getMessage(), e);
                    }
                }
                EvidenceBasedReport evidenceBasedReport = mongoTemplate.findById(id, EvidenceBasedReport.class, "evidence_based_report");
                if (downloadType.contains("3")) {// 说明书
                    String instructionTempFilePath = tempFilePath;
                    instructionTempFilePath = CommonUtil.removeSeparatorFromSuffix(instructionTempFilePath.concat(Constants.EXCEL_FILE_PATH_INSTRUCTION)).concat(Constants.PAD_LEFT_SLASH);
                    if (!FileUtil.exist(instructionTempFilePath)) {
                        FileUtil.mkParentDirs(instructionTempFilePath);
                        FileUtil.mkdir(instructionTempFilePath);
                    }
                    if (Objects.nonNull(evidenceBasedReport)) {
                        JSONArray instructionsIds = evidenceBasedReport.getInstructionsIds();
                        if (Objects.nonNull(instructionsIds) && CollUtil.isNotEmpty(instructionsIds)) {
                            List<DrugInfo> drugInfos = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(instructionsIds)), DrugInfo.class);
                            List<BaseExcelExportBean> instructionsExcelExportBeanList = new ArrayList<>();
                            // 分批处理说明书
                            batchGetDataForExcel(drugInfos, instructionsExcelExportBeanList,  3);
                            try {
                                ExcelResponseUtil.buildExcelFile(InstructionExcelExportBean.class, instructionsExcelExportBeanList, question.getName(), 3, "说明书", simpleDateFormat, instructionTempFilePath);
                            } catch (IOException e) {
                                log.error(e.getMessage(), e);
                            }
                        }
                    }
                }
                if (downloadType.contains("4")) {
                    String tempFilePathAds = CommonUtil.removeSeparatorFromSuffix(localExcelPath).concat(Constants.PAD_LEFT_SLASH).concat(idStr)
                            .concat(Constants.PAD_LEFT_SLASH).concat(name.concat("-").concat(simpleDateFormat.format(new DateTime()))).concat(Constants.PAD_LEFT_SLASH);
                    tempFilePathAds = CommonUtil.removeSeparatorFromSuffix(tempFilePathAds.concat(Constants.EXCEL_FILE_PATH_ADRS)).concat(Constants.PAD_LEFT_SLASH);
                    if (!FileUtil.exist(tempFilePathAds)) {
                        FileUtil.mkParentDirs(tempFilePathAds);
                        FileUtil.mkdir(tempFilePathAds);
                    }
                    if (Objects.nonNull(evidenceBasedReport)) {
                        // 不良反应 pdf?
                        try {
                            JSONObject adverseReaction = evidenceBasedReport.getAdverseReaction();
                            if (Objects.nonNull(adverseReaction)) {
                                this.createAdrsPdf(adverseReaction, question.getName(), tempFilePathAds, "不良反应");
                            }                            
                        } catch (Exception e) {
                            log.error(e.getMessage(), e);
                        }
                    }
                }
//                if (downloadType.contains("5")) {
//                    String htaTempFilePath = tempFilePath;
//                    htaTempFilePath = CommonUtil.removeSeparatorFromSuffix(htaTempFilePath.concat(Constants.EXCEL_FILE_PATH_HTA)).concat(Constants.PAD_LEFT_SLASH);
//                    if (!FileUtil.exist(htaTempFilePath)) {
//                        FileUtil.mkParentDirs(htaTempFilePath);
//                        FileUtil.mkdir(htaTempFilePath);
//                    }
//
//                    List<HtaIncludeOrExclude> htaIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), HtaIncludeOrExclude.class);
//                    List<String> includeIds = htaIncludeOrExcludes.stream().map(HtaIncludeOrExclude::getHtaId).collect(Collectors.toList());
//                    List<HtaReport> resultHtaReports = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(includeIds)), HtaReport.class);
//
//
//                    // hta
//                    if (Objects.nonNull(evidenceBasedReport)) {
//                        JSONObject htaMain = evidenceBasedReport.getHtaMain();
//                        JSONObject htaReportByOtherVarious = htaMain.getJSONObject("htaReportByOtherVarious").getJSONObject("htaReportByOtherVarious");
//                        List<HtaReport> htaReports = new ArrayList<>();
//                        List<BaseExcelExportBean> htaExcelExportBeanList = new ArrayList<>();
//                        this.assemblyHtaReport(htaReportByOtherVarious, htaReports);
//                        // 分批处理hta
//                        batchGetDataForExcel(htaReports, htaExcelExportBeanList, 4);
//                        try {
//                            ExcelResponseUtil.buildExcelFile(HtaExcelExportBean.class, htaExcelExportBeanList, question.getName(), 4, "hta", simpleDateFormat, htaTempFilePath);
//                        } catch (IOException e) {
//                            log.error(e.getMessage(), e);
//                        }
//                    }
//                }
//                if (downloadType.contains("6")) {
//                    String clinicalTrialsTempFilePath = tempFilePath;
//                    clinicalTrialsTempFilePath = CommonUtil.removeSeparatorFromSuffix(clinicalTrialsTempFilePath.concat(Constants.EXCEL_FILE_PATH_CLINICAL)).concat(Constants.PAD_LEFT_SLASH);
//                    if (!FileUtil.exist(clinicalTrialsTempFilePath)) {
//                        FileUtil.mkParentDirs(clinicalTrialsTempFilePath);
//                        FileUtil.mkdir(clinicalTrialsTempFilePath);
//                    }
//                    // 临床试验
//                    if (Objects.nonNull(evidenceBasedReport)) {
//                        JSONObject htaMain = evidenceBasedReport.getHtaMain();
//                        JSONObject clinicalTrials = htaMain.getJSONObject("guideAndLiteratureAndOtherInfo").getJSONObject("otherSourceDrugInfo").getJSONObject("clinicalTrials");
//                        List<ClinicalBo> clinicalIndices = new ArrayList<>();
//                        List<BaseExcelExportBean> clinicalExcelExportBeanList = new ArrayList<>();
//                        this.assemblyClinical(clinicalTrials, clinicalIndices);
//                        // 分批处理临床试验
//                        batchGetDataForExcel(clinicalIndices, clinicalExcelExportBeanList, 5);
//                        try {
//                            ExcelResponseUtil.buildExcelFile(ClinicalExcelExportBean.class, clinicalExcelExportBeanList, question.getName(), 5, "临床试验", simpleDateFormat, clinicalTrialsTempFilePath);
//                        } catch (IOException e) {
//                            log.error(e.getMessage(), e);
//                        }
//                    }
//                }
            }
            // 课题所在路径
            String tempFilePath = CommonUtil.removeSeparatorFromSuffix(localExcelPath).concat(Constants.PAD_LEFT_SLASH).concat(idStr);
//            File zip = ZipUtil.zip(tempFilePath);
            response.setCharacterEncoding("UTF-8");
            ServletUtil.write(response, ZipUtil.zip(tempFilePath));
        }
    }

    @Override
    public Boolean generateHistoricalRecords(String id) {
        Question pQuestion = mongoTemplate.findById(id, Question.class);
        if (pQuestion != null) {
            Question question = new Question();
            String pId = pQuestion.getPId();
            if ("-1".equals(pId)) {
                pId = id;
            }
            BeanUtils.copyProperties(pQuestion, question);
            
            String newId = UUID.randomUUID().toString();
            question.setId(newId);
            question.setPId(pId);
            long timeMillis = System.currentTimeMillis();
            question.setUpdateTime(timeMillis);
            question.setCreateTime(timeMillis);
            question.setCollectStatus(question.getCollectStatus());
            
            String name = pQuestion.getName();
            Integer historyNum = pQuestion.getHistoryNum();
            question.setName(name + "-" + historyNum);
            //将原来数据的historyNum+1
            historyNum = historyNum + 1;
            question.setHistoryNum(historyNum);
            try {
                mongoTemplate.save(question);
                Update update = new Update();
                update.set("historyNum", historyNum);
                mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(id)), update, Question.class);
                
                //只保留最新的3个历史记录
                List<Question> questions = mongoTemplate.find(new Query(Criteria.where("pId").is(pId)).with(Sort.by(Sort.Direction.DESC, "updateTime")), Question.class);
                if (questions.size() > 3) {
                    List<String> deleteIds = new ArrayList<>();
                    for (int i = 3; i < questions.size(); i++) {
                        deleteIds.add(questions.get(i).getId());
                    }
                    mongoTemplate.remove(new Query(Criteria.where("_id").in(deleteIds)), Question.class);
                }
                
                //复制新的检索条件表
                Condition pCondition = mongoTemplate.findById(id, Condition.class);
                if (pCondition != null) {
                    Condition condition = new Condition();
                    BeanUtils.copyProperties(pCondition, condition);
                    condition.setId(newId);
                    mongoTemplate.save(condition);
                }
                Query query = new Query(Criteria.where("conditionId").is(id));
                //复制文献质量修改
                List<PaperQuality> paperQualities = mongoTemplate.find(query, PaperQuality.class);
                if (CollUtil.isNotEmpty(paperQualities)) {
                    List<PaperQuality> newPaperQualities = new ArrayList<>();
                    paperQualities.forEach(paperQuality -> {
                        paperQuality.setId(UUID.randomUUID().toString());
                        paperQuality.setConditionId(newId);
                        newPaperQualities.add(paperQuality);
                    });
                    mongoTemplate.insert(newPaperQualities, PaperQuality.class);
                }
                //复制文献纳排
                List<PaperIncludeOrExclude> includeOrExcludeList = mongoTemplate.find(query, PaperIncludeOrExclude.class);
                if (CollUtil.isNotEmpty(includeOrExcludeList)){
                    List<PaperIncludeOrExclude> newIncludeOrExcludeList = new ArrayList<>();
                    includeOrExcludeList.forEach(paperIncludeOrExclude -> {
                        paperIncludeOrExclude.setId(UUID.randomUUID().toString());
                        paperIncludeOrExclude.setConditionId(newId);
                        newIncludeOrExcludeList.add(paperIncludeOrExclude);
                    });
                    mongoTemplate.insert(newIncludeOrExcludeList, PaperIncludeOrExclude.class);
                }
                //复制指南纳排
                List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(query, GuideIncludeOrExclude.class);
                if (CollUtil.isNotEmpty(guideIncludeOrExcludes)) {
                    List<GuideIncludeOrExclude> newGuideIncludeOrExcludes = new ArrayList<>();
                    guideIncludeOrExcludes.forEach(guideIncludeOrExclude -> {
                        guideIncludeOrExclude.setId(UUID.randomUUID().toString());
                        guideIncludeOrExclude.setConditionId(newId);
                        newGuideIncludeOrExcludes.add(guideIncludeOrExclude);
                    });
                    mongoTemplate.insert(newGuideIncludeOrExcludes, GuideIncludeOrExclude.class);
                }
                //复制临床试验纳排
                List<ClinicalTrialsIncludeOrExclude> clinicalTrialsIncludeOrExcludes = mongoTemplate.find(query, ClinicalTrialsIncludeOrExclude.class);
                if (CollUtil.isNotEmpty(clinicalTrialsIncludeOrExcludes)) {
                    List<ClinicalTrialsIncludeOrExclude> newClinicalTrialsIncludeOrExcludes = new ArrayList<>();
                    clinicalTrialsIncludeOrExcludes.forEach(clinicalTrialsIncludeOrExclude -> {
                        clinicalTrialsIncludeOrExclude.setId(UUID.randomUUID().toString());
                        clinicalTrialsIncludeOrExclude.setConditionId(newId);
                        newClinicalTrialsIncludeOrExcludes.add(clinicalTrialsIncludeOrExclude);
                    });
                    mongoTemplate.insert(newClinicalTrialsIncludeOrExcludes, ClinicalTrialsIncludeOrExclude.class);
                }

                //复制报告
                ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
                if (reportContent != null) {
                    reportContent.setId(newId);
                    mongoTemplate.save(reportContent, "evidence_report_content");
                }

                // 先把原先的删除
                ReportContent reportContentNew = new ReportContent();
                reportContentNew.setId(id);
                if (Objects.nonNull(reportContent)) {
                    reportContentNew.setTidyIndications(CollUtil.isNotEmpty(reportContent.getTidyIndications()) ? reportContent.getTidyIndications() : new ArrayList<>());
                    reportContentNew.setTidyDrugs(CollUtil.isNotEmpty(reportContent.getTidyDrugs()) ? reportContent.getTidyDrugs() : new ArrayList<>());
                }
                mongoTemplate.remove(new Query(Criteria.where("_id").is(id)), "evidence_report_content");
                // 再插入一个只有 id 的空 reportContent
                mongoTemplate.save(reportContentNew, "evidence_report_content");

                String oriTempKey = Constants.TEMPLATE_ORI + id;
                String oriTemplate = RedisUtils.getStr(oriTempKey);
                if (StrUtil.isNotBlank(oriTemplate)) {
                    RedisUtils.set(Constants.TEMPLATE_ORI + newId, oriTemplate);
                }
                String modiTempKey = Constants.TEMPLATE_MODI + id;
                String modiTemplate = RedisUtils.getStr(modiTempKey);
                if (StrUtil.isNotBlank(modiTemplate)) {
                    RedisUtils.set(Constants.TEMPLATE_MODI + newId, modiTemplate);
                }

                return true;
            } catch (BeansException e) {
               log.error(e.getMessage(), e);
            }
        }
        return false;
        
    }

    private void assemblyClinical(JSONObject clinicalTrials, List<ClinicalBo> clinicalBos) {
        JSONArray table = clinicalTrials.getJSONArray("table");
        if (Objects.nonNull(table) && CollUtil.isNotEmpty(table)) {
            copyClinicalData(table, clinicalBos);
        }
    }

    private void copyClinicalData(JSONArray table, List<ClinicalBo> clinicalBos) {
        for (Object o : table) {
            JSONObject jsonObject = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
            ClinicalBo clinicalBo = new ClinicalBo();
            clinicalBo.setRegisterNo(jsonObject.getString("nctNumber"));
            clinicalBo.setStudyTitle(jsonObject.getString("title"));
            clinicalBo.setRegisterDate(jsonObject.getString("registerDate"));
            clinicalBo.setStudyType(jsonObject.getString("studyType"));
            clinicalBo.setStudyPhase(jsonObject.getString("studyPhase"));
            clinicalBo.setSampleSize(jsonObject.getString("sampleSize"));
            clinicalBo.setIntervention(jsonObject.getString("intervention"));
            clinicalBo.setCondition(jsonObject.getString("studyDiseases"));
            clinicalBos.add(clinicalBo);
        }
    }

    private void assemblyHtaReport(JSONObject htaReportByOtherVarious, List<HtaReport> htaReports) {
        JSONArray pbs = htaReportByOtherVarious.getJSONArray("PBS");
        if (Objects.nonNull(pbs) && CollUtil.isNotEmpty(pbs)) {
            copyData(pbs, htaReports);
        }
        JSONArray inahta = htaReportByOtherVarious.getJSONArray("INAHTA");
        if (Objects.nonNull(inahta) && CollUtil.isNotEmpty(inahta)) {
            copyData(inahta, htaReports);
        }
        JSONArray iqwig = htaReportByOtherVarious.getJSONArray("IQWIG");
        if (Objects.nonNull(iqwig) && CollUtil.isNotEmpty(iqwig)) {
            copyData(iqwig, htaReports);
        }
        JSONArray awmsg = htaReportByOtherVarious.getJSONArray("AWMSG");
        if (Objects.nonNull(awmsg) && CollUtil.isNotEmpty(awmsg)) {
            copyData(awmsg, htaReports);
        }
        JSONArray smc = htaReportByOtherVarious.getJSONArray("SMC");
        if (Objects.nonNull(smc) && CollUtil.isNotEmpty(smc)) {
            copyData(smc, htaReports);
        }
        JSONArray nice = htaReportByOtherVarious.getJSONArray("NICE");
        if (Objects.nonNull(nice) && CollUtil.isNotEmpty(nice)) {
            copyData(nice, htaReports);
        }
    }

    private void copyData(JSONArray smc, List<HtaReport> htaReports) {
        for (Object o : smc) {
            JSONObject jsonObject = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
            HtaReport htaReport = new HtaReport();
            htaReport.setTitle(jsonObject.getString("title"));
            htaReport.setSource(jsonObject.getString("source"));
            JSONArray publishTime = jsonObject.getJSONArray("publishTime");
            List<String> publishTimes = JSON.parseObject(JSON.toJSONString(publishTime), new TypeReference<List<String>>() {
            });
            htaReport.setPublishTime(String.join(",", publishTimes));
            htaReport.setLink(jsonObject.getString("link"));
            htaReports.add(htaReport);
        }
    }


    private <T> void batchGetDataForExcel(List<T> dataList, List<BaseExcelExportBean> excelExportBeans, int type) {
        if (CollUtil.isNotEmpty(dataList)) {
            int count = dataList.size();
            List<T> handleDataLists;
            if (count >= 900) {
                handleDataLists = CollUtil.sub(dataList, 0, 899);
            } else {
                handleDataLists = new ArrayList<>(dataList);
            }
            // 文献
            if (type == 1) {
                List<MongoLiterature> mongoLiteratures = JSON.parseObject(JSON.toJSONString(handleDataLists), new TypeReference<List<MongoLiterature>>(){});
                for (MongoLiterature mongoLiterature : mongoLiteratures) {
                    String language = mongoLiterature.getLanguage();
                    List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
                    List<String> journalDivision = mongoLiterature.getJournalDivision();
                    if (StrUtil.isNotBlank(language)) {
                        if ("zh".equals(language)) {
                            mongoLiterature.setJcr(null);
                            if (Objects.nonNull(recognizedKernelJournals)
                                    && CollUtil.isNotEmpty(recognizedKernelJournals)) {
                                mongoLiterature.setCoreJournal(String.join("、", mongoLiterature.getRecognizedKernelJournals()));
                            }
                        }
                        if ("en".equals(language)) {
                            if (Objects.nonNull(journalDivision)
                                    && CollUtil.isNotEmpty(journalDivision)) {
                                mongoLiterature.setCoreJournal(String.join("、", mongoLiterature.getJournalDivision()));
                            }
                        }
                    }
                    PaperExcelExportBean paperExcelExportBean = MongoLiteratureBoToBeanConverter.INSTANCE.boToBean(mongoLiterature);
                    paperExcelExportBean.setNumber(String.valueOf(excelExportBeans.size() + 1));
                    List<String> author = mongoLiterature.getAuthor();
                    if (CollUtil.isEmpty(author)) {
                        paperExcelExportBean.setAuthor(Collections.singletonList(""));
                    }
                    excelExportBeans.add(paperExcelExportBean);
                }
            }
            // 指南
            if (type == 2) {
                List<GuideIndex> guideIndices = JSON.parseObject(JSON.toJSONString(handleDataLists), new TypeReference<List<GuideIndex>>(){});
                for (GuideIndex guide : guideIndices) {
                    GuideExcelExportBean guideExcelExportBean = GuideBoToBeanConverter.INSTANCE.boToBean(guide);
                    guideExcelExportBean.setNumber(String.valueOf(excelExportBeans.size() + 1));
                    excelExportBeans.add(guideExcelExportBean);
                }
            }
            // 说明书
            if (type == 3) {
                List<DrugInfo> drugInfos = JSON.parseObject(JSON.toJSONString(handleDataLists), new TypeReference<List<DrugInfo>>(){});
                for (DrugInfo drugInfo : drugInfos) {
                    excelExportBeans.add(InstructionBoToBeanConverter.INSTANCE.boToBean(drugInfo));
                }
            }
            // hta
            if (type == 4) {
                List<HtaReport> htaReports = JSON.parseObject(JSON.toJSONString(handleDataLists), new TypeReference<List<HtaReport>>(){});
                for (HtaReport htaReport : htaReports) {
                    HtaExcelExportBean htaExcelExportBean = HtaBoToBeanConverter.INSTANCE.boToBean(htaReport);
                    htaExcelExportBean.setNumber(String.valueOf(excelExportBeans.size() + 1));
                    excelExportBeans.add(htaExcelExportBean);
                }
            }
            // 临床试验
            if (type == 5) {
                List<ClinicalBo> clinicalBos = JSON.parseObject(JSON.toJSONString(handleDataLists), new TypeReference<List<ClinicalBo>>(){});
                for (ClinicalBo clinicalBo : clinicalBos) {
                    ClinicalExcelExportBean clinicalExcelExportBean = ClinicalBoToBeanConverter.INSTANCE.boToBean(clinicalBo);
                    clinicalExcelExportBean.setNumber(String.valueOf(excelExportBeans.size() + 1));
                    excelExportBeans.add(clinicalExcelExportBean);
                }
            }
            if (count > dataList.size()) {
                batchGetDataForExcel(new ArrayList<>(CollUtil.subtract(handleDataLists, dataList)), excelExportBeans, type);
            }
        }
    }

    /**
     * pdf写入单元格逻辑
     *
     * @throws Exception 向上一层抛出异常
     */
    public void createAdrsPdf(JSONObject adverseReaction, String drugName, String tempFilePath, String typeName) throws Exception {
        Document document = new Document(PageSize.A4);
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyyMMdd", Locale.CHINA);
        String filename = drugName.concat("_").concat(typeName).concat("_").concat(simpleDateFormat.format(new DateTime())).concat(Constants.FILE_EXT_NAME_PDF);
        File file = new File(CommonUtil.removeSeparatorFromSuffix(tempFilePath).concat(Constants.PAD_LEFT_SLASH).concat(filename));
        PdfWriter writer = PdfWriter.getInstance(document, new FileOutputStream(file));
        writer.setPageEvent(new MyHeaderFooter());
        document.open();

        Color color = Color.decode("#475792");
        Color butColor = Color.decode("#F5F7FA");
        Color badColor = Color.decode("#DADDE9");
        BaseColor baseColor = new BaseColor(color.getRed(), color.getGreen(), color.getBlue());
        BaseColor baseButColor = new BaseColor(butColor.getRed(), butColor.getGreen(), butColor.getBlue());
        BaseColor baseBadColor = new BaseColor(badColor.getRed(), badColor.getGreen(), badColor.getBlue());
        BaseFont zhFont = BaseFont.createFont("STSong-Light", "UniGB-UCS2-H", BaseFont.EMBEDDED);
        Font keyfont = new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE);
        Font blueFont = new Font(zhFont, 12, Font.NORMAL, BaseColor.BLUE);

        document.add(createParagraph("禁忌和特殊人群用药提醒"));
        // 禁忌和特殊人群用药提醒
        JSONArray instruction = adverseReaction.getJSONArray("instruction");
        if (Objects.nonNull(instruction) && CollUtil.isNotEmpty(instruction)) {
            for (Object o : instruction) {
                JSONObject ins = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                // 禁忌
                JSONArray taboo = ins.getJSONArray("taboo");
                PdfPTable badlyTable = createTable(new float[]{520});

                // 禁忌内容
                List<Map<String, Object>> tabooMaps = JSON.parseObject(JSON.toJSONString(taboo), new TypeReference<List<Map<String, Object>>>() {
                });
                if (CollUtil.isNotEmpty(tabooMaps)) {
                    PdfPCell tabooCell = createCell("禁忌", new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE), Element.ALIGN_LEFT);
                    tabooCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    tabooCell.setBackgroundColor(baseColor);
                    badlyTable.addCell(tabooCell);

                    for (Map<String, Object> tabooMap : tabooMaps) {
                        PdfPCell tabooContentCell = new PdfPCell();
                        tabooContentCell.setHorizontalAlignment(Element.ALIGN_LEFT);

                        assembleListData(tabooMap, tabooContentCell, zhFont);

                        tabooContentCell.setBackgroundColor(baseBadColor);
                        tabooContentCell.setLeading(0f, 1.2f);
                        tabooContentCell.setPaddingBottom(4f);
                        badlyTable.addCell(tabooContentCell);
                    }
                }



                // 特殊人群用药提醒
                JSONObject special = ins.getJSONObject("special");
                PdfPCell crowdCell = createCell("特殊人群用药提醒", new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE), Element.ALIGN_LEFT);
                crowdCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                crowdCell.setBackgroundColor(baseColor);
                badlyTable.addCell(crowdCell);

                JSONArray women = special.getJSONArray("women");
                List<Map<String, Object>> womenMaps = JSON.parseObject(JSON.toJSONString(women), new TypeReference<List<Map<String, Object>>>() {
                });
                if (CollUtil.isNotEmpty(womenMaps)) {
                    PdfPCell cell = new PdfPCell();
                    cell.setBackgroundColor(baseBadColor);
                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                    Phrase womenPar = new Phrase("", EvimedPdfFont.TEXT);
                    womenPar.add("孕妇及哺乳期妇女:");
                    womenPar.add("\n");
                    cell.addElement(womenPar);
                    badlyTable.addCell(cell);

                    for (Map<String, Object> womenMap : womenMaps) {
                        PdfPCell innerCell = new PdfPCell();
                        innerCell.setHorizontalAlignment(Element.ALIGN_LEFT);

                        assembleListDataCopy(womenMap, innerCell, zhFont);

                        innerCell.setBackgroundColor(baseBadColor);
                        innerCell.setLeading(0f, 1.2f);
                        innerCell.setPaddingBottom(4f);
                        badlyTable.addCell(innerCell);
                    }
                }


                JSONArray children = special.getJSONArray("children");
                List<Map<String, Object>> childrenMaps = JSON.parseObject(JSON.toJSONString(children), new TypeReference<List<Map<String, Object>>>() {
                });
                if (CollUtil.isNotEmpty(childrenMaps)) {
                    PdfPCell childrenCell = new PdfPCell();
                    childrenCell.setBackgroundColor(baseBadColor);
                    childrenCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    childrenCell.setHorizontalAlignment(Element.ALIGN_LEFT);
                    Phrase childrenPar = new Phrase("", EvimedPdfFont.TEXT);
                    childrenPar.add("儿童用药:");
                    childrenPar.add("\n");
                    childrenCell.setPhrase(childrenPar);
                    badlyTable.addCell(childrenCell);

                    for (Map<String, Object> childrenMap : childrenMaps) {
                        PdfPCell innerCell = new PdfPCell();
                        innerCell.setHorizontalAlignment(Element.ALIGN_LEFT);

                        assembleListDataCopy(childrenMap, innerCell, zhFont);

                        innerCell.setBackgroundColor(baseBadColor);
                        innerCell.setLeading(0f, 1.2f);
                        innerCell.setPaddingBottom(4f);
                        badlyTable.addCell(innerCell);
                    }
                }


                JSONArray old = special.getJSONArray("old");
                List<Map<String, Object>> oldMaps = JSON.parseObject(JSON.toJSONString(old), new TypeReference<List<Map<String, Object>>>() {
                });
                if (CollUtil.isNotEmpty(oldMaps)) {
                    PdfPCell oldCell = new PdfPCell();
                    oldCell.setBackgroundColor(baseBadColor);
                    oldCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    oldCell.setHorizontalAlignment(Element.ALIGN_LEFT);
                    Phrase oldPar = new Phrase("", EvimedPdfFont.TEXT);
                    oldPar.add("老人用药:");
                    oldPar.add("\n");
                    oldCell.setPhrase(oldPar);
                    badlyTable.addCell(oldCell);

                    for (Map<String, Object> oldMap : oldMaps) {
                        PdfPCell innerCell = new PdfPCell();
                        innerCell.setHorizontalAlignment(Element.ALIGN_LEFT);

                        assembleListDataCopy(oldMap, innerCell, zhFont);

                        innerCell.setBackgroundColor(baseBadColor);
                        innerCell.setLeading(0f, 1.2f);
                        innerCell.setPaddingBottom(4f);
                        badlyTable.addCell(innerCell);

                    }
                }


                // 不良反应
                JSONArray adverse = ins.getJSONArray("adverse");
                List<Map<String, Object>> adverseMaps = JSON.parseObject(JSON.toJSONString(adverse), new TypeReference<List<Map<String, Object>>>() {
                });
                if (CollUtil.isNotEmpty(adverseMaps)) {
                    PdfPCell adverseCell = createCell("不良反应", new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE), Element.ALIGN_LEFT);
                    adverseCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    adverseCell.setBackgroundColor(baseColor);
                    badlyTable.addCell(adverseCell);

                    for (Map<String, Object> adverseMap : adverseMaps) {
                        PdfPCell adverseContentCell = new PdfPCell();
                        adverseContentCell.setHorizontalAlignment(Element.ALIGN_LEFT);

                        assembleListData(adverseMap, adverseContentCell, zhFont);

                        adverseContentCell.setBackgroundColor(baseBadColor);
                        adverseContentCell.setLeading(0f, 1.2f);
                        adverseContentCell.setPaddingBottom(4f);
                        badlyTable.addCell(adverseContentCell);
                    }
                }
                document.add(badlyTable);
            }
        }

        document.add(createParagraph("政策信息"));
        // 政策信息
        JSONObject policy = adverseReaction.getJSONObject("policy");
        if (Objects.nonNull(policy)) {
            JSONObject newsFlash = policy.getJSONObject("newsFlash");
            if (Objects.nonNull(newsFlash)) {
                JSONArray innerArray = newsFlash.getJSONArray("contentsWordArray");
                if (CollUtil.isNotEmpty(innerArray)) {
                    PdfPTable policyTable = createTable(new float[]{520});
                    PdfPCell policyCell = createCell("药物警戒快讯", new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE), Element.ALIGN_LEFT);
                    policyCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    policyCell.setBackgroundColor(baseColor);
                    policyTable.addCell(policyCell);
                    for (Object o : innerArray) {
                        String content = JSON.parseObject(JSON.toJSONString(o), String.class);
                        // 警戒内容
                        PdfPCell policyContentCell = new PdfPCell();
                        policyContentCell.setHorizontalAlignment(Element.ALIGN_LEFT);
                        policyContentCell.setPhrase(new Phrase(o.toString(), new Font(zhFont)));
                        policyContentCell.setBackgroundColor(baseBadColor);
                        policyContentCell.setLeading(0f, 1.2f);
                        policyContentCell.setPaddingBottom(4f);
                        policyTable.addCell(policyContentCell);
                    }
                    document.add(policyTable);
                }
            }
        }



        document.add(createParagraph("FAERS数据库典型信号分析"));
        // 典型信号
        JSONObject adverse = adverseReaction.getJSONObject("adverse");
        JSONObject calculateTypicalSignals = adverse.getJSONObject("calculateTypicalSignals");
        JSONArray data = calculateTypicalSignals.getJSONArray("data");
        if (Objects.nonNull(data) && CollUtil.isNotEmpty(data)) {
            PdfPTable drugTable = createTable(new float[]{100, 50, 50, 50, 50, 50, 50});
            drugTable.addCell(createCell(calculateTypicalSignals.getString("info"), EvimedPdfFont.HEAD, Element.ALIGN_LEFT, 7, false));
            PdfPCell symptomCell = createCellY("SOC分类/首选属于(PT)", keyfont, Element.ALIGN_CENTER, 1);
            symptomCell.setBackgroundColor(baseColor);
            drugTable.addCell(symptomCell);
            PdfPCell dataBaseCell = createCell("SOC分类/首选属于(PT)", keyfont, Element.ALIGN_CENTER, 1);
            dataBaseCell.setBackgroundColor(baseColor);
            drugTable.addCell(dataBaseCell);
            PdfPCell rateCell = createCell("不良事件", keyfont, Element.ALIGN_CENTER, 1);
            rateCell.setBackgroundColor(baseColor);
            drugTable.addCell(rateCell);
            PdfPCell rorCell = createCell("报告数/例", keyfont, Element.ALIGN_CENTER);
            rorCell.setBackgroundColor(baseColor);
            drugTable.addCell(rorCell);
            PdfPCell ebgmCell = createCell("ROR值", keyfont, Element.ALIGN_CENTER);
            ebgmCell.setBackgroundColor(baseColor);
            drugTable.addCell(ebgmCell);
            PdfPCell icCell = createCell("EBGM值", keyfont, Element.ALIGN_CENTER);
            icCell.setBackgroundColor(baseColor);
            drugTable.addCell(icCell);
            PdfPCell adrCell = createCell("IC值", keyfont, Element.ALIGN_CENTER);
            icCell.setBackgroundColor(baseColor);
            adrCell.setBackgroundColor(baseColor);
            drugTable.addCell(adrCell);
            Map<String, List<String>> memo = new LinkedHashMap<>();
            for (int j = 0; j < data.size(); j++) {
                JSONObject dataJson = data.getJSONObject(j);
                String soc = dataJson.getString("soc");
                PdfPCell socCell1 = createCell(soc, EvimedPdfFont.TEXT);
                drugTable.addCell(socCell1);

                String en = dataJson.getString("en");
                PdfPCell enCell1 = createCell(en, EvimedPdfFont.TEXT);
                //rateCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(enCell1);

                String zh = dataJson.getString("zh");
                PdfPCell zhCell1 = createCell(zh, EvimedPdfFont.TEXT);
                //rorCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(zhCell1);

                Long num_ = dataJson.getLong("num");
                PdfPCell numCell1 = createCell(num_ + "", EvimedPdfFont.TEXT);
                //ebgmCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(numCell1);

                String ror = dataJson.getString("ror");
                PdfPCell rorCell1 = createCell(ror, EvimedPdfFont.TEXT);
                //ebgmCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(rorCell1);

                String ebgm = dataJson.getString("ebgm");
                PdfPCell ebgmCell1 = createCell(ebgm, EvimedPdfFont.TEXT);
                //ebgmCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(ebgmCell1);

                String ic = dataJson.getString("ic");
                PdfPCell icCell1 = createCell(ic, EvimedPdfFont.TEXT);
                //ebgmCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(icCell1);
            }
            drugTable.setSplitLate(false);
            drugTable.setSplitRows(true);
            document.add(drugTable);
        }
        document.close();
    }
    /*public void createAdrsPdf(JSONObject adverseReaction, String drugName, String tempFilePath, String typeName) throws Exception {
        Document document = new Document(PageSize.A4);
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyyMMdd", Locale.CHINA);
        String filename = drugName.concat("_").concat(typeName).concat("_").concat(simpleDateFormat.format(new DateTime())).concat(Constants.FILE_EXT_NAME_PDF);
        File file = new File(CommonUtil.removeSeparatorFromSuffix(tempFilePath).concat(Constants.PAD_LEFT_SLASH).concat(filename));
        PdfWriter writer = PdfWriter.getInstance(document, new
                FileOutputStream(file));
        writer.setPageEvent(new MyHeaderFooter());
        document.open();

        Color color = Color.decode("#475792");
        Color butColor = Color.decode("#F5F7FA");
        Color badColor = Color.decode("#DADDE9");
        BaseColor baseColor = new BaseColor(color.getRed(), color.getGreen(), color.getBlue());
        BaseColor baseButColor = new BaseColor(butColor.getRed(), butColor.getGreen(), butColor.getBlue());
        BaseColor baseBadColor = new BaseColor(badColor.getRed(), badColor.getGreen(), badColor.getBlue());
        BaseFont zhFont = BaseFont.createFont("STSong-Light", "UniGB-UCS2-H", BaseFont.EMBEDDED);
        Font keyfont = new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE);
        Font blueFont = new Font(zhFont, 12, Font.NORMAL, BaseColor.BLUE);

        document.add(createParagraph("禁忌和特殊人群用药提醒"));
        // 禁忌和特殊人群用药提醒
        JSONArray instruction = adverseReaction.getJSONArray("instruction");
        if (Objects.nonNull(instruction) && CollUtil.isNotEmpty(instruction)) {
            for (Object o : instruction) {
                JSONObject ins = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                // 禁忌
                String taboo = ins.getString("taboo");
                PdfPTable badlyTable = createTable(new float[]{520});
                PdfPCell tabooCell = createCell("禁忌", new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE), Element.ALIGN_LEFT);
                tabooCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                tabooCell.setBackgroundColor(baseColor);
                badlyTable.addCell(tabooCell);
                // 禁忌内容
                PdfPCell tabooContentCell = new PdfPCell();
                tabooContentCell.setHorizontalAlignment(Element.ALIGN_LEFT);
                tabooContentCell.setPhrase(new Phrase(taboo, new Font(zhFont)));
                tabooContentCell.setBackgroundColor(baseBadColor);
                tabooContentCell.setLeading(0f, 1.2f);
                tabooContentCell.setPaddingBottom(4f);
                badlyTable.addCell(tabooContentCell);

                // 特殊人群用药提醒
                JSONObject special = ins.getJSONObject("special");
                PdfPCell crowdCell = createCell("特殊人群用药提醒", new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE), Element.ALIGN_LEFT);
                crowdCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                crowdCell.setBackgroundColor(baseColor);
                badlyTable.addCell(crowdCell);
                PdfPCell cell = new PdfPCell();
                cell.setBackgroundColor(baseBadColor);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                Phrase resPar = new Phrase("", EvimedPdfFont.TEXT);
                String women = special.getString("women");
                resPar.add("孕妇及哺乳期妇女:" + women);
                resPar.add("\n");
                String children = special.getString("children");
                resPar.add("儿童用药:" + children);
                resPar.add("\n");
                String old = special.getString("old");
                resPar.add("老人用药:" + old);
                resPar.add("\n");
                cell.setPhrase(resPar);
                cell.setPaddingBottom(4f);
                cell.setLeading(0f, 1.2f);
                badlyTable.addCell(cell);
                
                // 不良反应
                String adverse = ins.getString("adverse");
                PdfPTable adverseTable = createTable(new float[]{520});
                PdfPCell adverseCell = createCell("不良反应", new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE), Element.ALIGN_LEFT);
                adverseCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                adverseCell.setBackgroundColor(baseColor);
                badlyTable.addCell(adverseCell);
                // 不良反应内容
                PdfPCell adverseContentCell = new PdfPCell();
                adverseContentCell.setHorizontalAlignment(Element.ALIGN_LEFT);
                adverseContentCell.setPhrase(new Phrase(adverse, new Font(zhFont)));
                adverseContentCell.setBackgroundColor(baseBadColor);
                adverseContentCell.setLeading(0f, 1.2f);
                adverseContentCell.setPaddingBottom(4f);
                badlyTable.addCell(adverseContentCell);
                document.add(badlyTable);
            }
        }

        document.add(createParagraph("政策信息"));
        // 政策信息
        JSONObject policy = adverseReaction.getJSONObject("policy");
        JSONArray newsFlash = policy.getJSONArray("newsFlash");
        int num = 0;

        if (Objects.nonNull(newsFlash) && CollUtil.isNotEmpty(newsFlash)) {
            for (int i = 0; i < newsFlash.size(); i++) {
                JSONArray contents = newsFlash.getJSONObject(i).getJSONArray("contents");
                if (Objects.nonNull(contents) && CollUtil.isNotEmpty(contents)) {
                    JSONArray array = new JSONArray();
                    for (Object content : contents) {
//                        String circleNumber = String.valueOf((char) (0x2460 + num++));
//                        StringBuilder cont = new StringBuilder(circleNumber).append(" ");
//                        cont.append(newsFlash.getJSONObject(i).getString("title"));
//                        JSONObject jsonObject = JSON.parseObject(JSON.toJSONString(content), JSONObject.class);
//                        cont.append(": ").append(jsonObject.getString("title"));
//                        cont.append("(").append(newsFlash.getJSONObject(i).getString("time")).append(")");
//                        cont.append("\n").append("原文链接：").append(newsFlash.getJSONObject(i).getString("url"));
                        array.add(content.toString());
                    }

                    PdfPTable policyTable = createTable(new float[]{520});
                    PdfPCell policyCell = createCell("药物警戒快讯", new Font(zhFont, 10, Font.NORMAL, BaseColor.WHITE), Element.ALIGN_LEFT);
                    policyCell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    policyCell.setBackgroundColor(baseColor);
                    policyTable.addCell(policyCell);
                    for (Object o : array) {
                        String content = JSON.parseObject(JSON.toJSONString(o), String.class);
                        // 警戒内容
                        PdfPCell policyContentCell = new PdfPCell();
                        policyContentCell.setHorizontalAlignment(Element.ALIGN_LEFT);
                        policyContentCell.setPhrase(new Phrase(content, new Font(zhFont)));
                        policyContentCell.setBackgroundColor(baseBadColor);
                        policyContentCell.setLeading(0f, 1.2f);
                        policyContentCell.setPaddingBottom(4f);
                        policyTable.addCell(policyContentCell);
                    }
                    document.add(policyTable);
                }
            }
        }

        document.add(createParagraph("FAERS数据库典型信号分析"));
        // 典型信号
        JSONObject adverse = adverseReaction.getJSONObject("adverse");
        JSONObject calculateTypicalSignals = adverse.getJSONObject("calculateTypicalSignals");
        JSONArray data = calculateTypicalSignals.getJSONArray("data");
        if (Objects.nonNull(data) && CollUtil.isNotEmpty(data)) {
            PdfPTable drugTable = createTable(new float[]{100, 50, 50, 50, 50, 50, 50});
            drugTable.addCell(createCell(calculateTypicalSignals.getString("info"), EvimedPdfFont.HEAD, Element.ALIGN_LEFT, 7, false));
            PdfPCell symptomCell = createCellY("SOC分类/首选属于(PT)", keyfont, Element.ALIGN_CENTER, 1);
            symptomCell.setBackgroundColor(baseColor);
            drugTable.addCell(symptomCell);
            PdfPCell dataBaseCell = createCell("SOC分类/首选属于(PT)", keyfont, Element.ALIGN_CENTER, 1);
            dataBaseCell.setBackgroundColor(baseColor);
            drugTable.addCell(dataBaseCell);
            PdfPCell rateCell = createCell("不良事件", keyfont, Element.ALIGN_CENTER, 1);
            rateCell.setBackgroundColor(baseColor);
            drugTable.addCell(rateCell);
            PdfPCell rorCell = createCell("报告数/例", keyfont, Element.ALIGN_CENTER);
            rorCell.setBackgroundColor(baseColor);
            drugTable.addCell(rorCell);
            PdfPCell ebgmCell = createCell("ROR值", keyfont, Element.ALIGN_CENTER);
            ebgmCell.setBackgroundColor(baseColor);
            drugTable.addCell(ebgmCell);
            PdfPCell icCell = createCell("EBGM值", keyfont, Element.ALIGN_CENTER);
            icCell.setBackgroundColor(baseColor);
            drugTable.addCell(icCell);
            PdfPCell adrCell = createCell("IC值", keyfont, Element.ALIGN_CENTER);
            icCell.setBackgroundColor(baseColor);
            adrCell.setBackgroundColor(baseColor);
            drugTable.addCell(adrCell);
            Map<String, List<String>> memo = new LinkedHashMap<>();
            for (int j = 0; j < data.size(); j++) {
                JSONObject dataJson = data.getJSONObject(j);
                String soc = dataJson.getString("soc");
                PdfPCell socCell1 = createCell(soc, EvimedPdfFont.TEXT);
                drugTable.addCell(socCell1);

                String en = dataJson.getString("en");
                PdfPCell enCell1 = createCell(en, EvimedPdfFont.TEXT);
                //rateCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(enCell1);

                String zh = dataJson.getString("zh");
                PdfPCell zhCell1 = createCell(zh, EvimedPdfFont.TEXT);
                //rorCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(zhCell1);

                Long num_ = dataJson.getLong("num");
                PdfPCell numCell1 = createCell(num_ + "", EvimedPdfFont.TEXT);
                //ebgmCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(numCell1);

                String ror = dataJson.getString("ror");
                PdfPCell rorCell1 = createCell(ror, EvimedPdfFont.TEXT);
                //ebgmCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(rorCell1);

                String ebgm = dataJson.getString("ebgm");
                PdfPCell ebgmCell1 = createCell(ebgm, EvimedPdfFont.TEXT);
                //ebgmCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(ebgmCell1);

                String ic = dataJson.getString("ic");
                PdfPCell icCell1 = createCell(ic, EvimedPdfFont.TEXT);
                //ebgmCell1.setBackgroundColor(baseButColor);
                drugTable.addCell(icCell1);
            }
            drugTable.setSplitLate(false);
            drugTable.setSplitRows(true);
            document.add(drugTable);
        }
        document.close();
    }*/

    private Paragraph createParagraph(String content) {
        // 段落
        Paragraph paragraph = new Paragraph(content, EvimedPdfFont.TITLE);
        //设置文字居中 0靠左   1，居中     2，靠右
        paragraph.setAlignment(1);
        //设置左缩进
        paragraph.setIndentationLeft(12);
        //设置右缩进
        paragraph.setIndentationRight(12);
        //设置首行缩进
        paragraph.setFirstLineIndent(24);
        //行间距
        paragraph.setLeading(20f);
        //设置段落上空白
        paragraph.setSpacingBefore(5f);
        //设置段落下空白
        paragraph.setSpacingAfter(10f);
        return paragraph;
    }

    /**
     * 创建指定列宽、列数的表格
     */
    public static PdfPTable createTable(float[] widths) {
        PdfPTable table = new PdfPTable(widths);
        try {
            table.setTotalWidth(MAX_WIDTH);
            table.setLockedWidth(true);
            table.setHorizontalAlignment(Element.ALIGN_CENTER);
            table.getDefaultCell().setBorder(1);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return table;
    }

    /**
     * 创建单元格（指定字体、水平居..、单元格跨y列合并）
     */
    public static PdfPCell createCellY(String value, Font font, int align, int rowspan) {
        PdfPCell cell = new PdfPCell();
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell.setHorizontalAlignment(align);
//        cell.setRowspan(rowspan);
        cell.setPhrase(new Phrase(value, font));
        return cell;
    }

    /**
     * 创建单元格（指定字体、水平居..、单元格跨x列合并、设置单元格内边距）
     */
    public static PdfPCell createCell(String value, Font font, int align, int colspan, boolean boderFlag) {
        PdfPCell cell = new PdfPCell();
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell.setHorizontalAlignment(align);
        cell.setColspan(colspan);
        cell.setPhrase(new Phrase(value, font));
        cell.setPadding(3.0f);
        if (!boderFlag) {
            cell.setBorder(0);
            cell.setPaddingTop(15.0f);
            cell.setPaddingBottom(8.0f);
        } else if (boderFlag) {
            cell.setBorder(0);
            cell.setPaddingTop(0.0f);
            cell.setPaddingBottom(15.0f);
        }
        return cell;
    }

    /**
     * 创建单元格（指定字体、水平居..、单元格跨x列合并）
     */
    public static PdfPCell createCell(String value, Font font, int align, int colspan) {
        PdfPCell cell = new PdfPCell();
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell.setHorizontalAlignment(align);
        cell.setColspan(colspan);
        cell.setPhrase(new Phrase(value, font));
        return cell;
    }

    /**
     * 创建单元格（指定字体、水平..）
     */
    public static PdfPCell createCell(String value, Font font, int align) {
        PdfPCell cell = new PdfPCell();
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell.setHorizontalAlignment(align);
        cell.setPhrase(new Phrase(value, font));
        return cell;
    }

    /**
     * 创建单元格(指定字体)
     */
    public PdfPCell createCell(String value, Font font) {
        PdfPCell cell = new PdfPCell();
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell.setPhrase(new Phrase(value, font));
        return cell;
    }

    private void assembleListData(Map<String, Object> tabooMap, PdfPCell tabooContentCell, BaseFont zhFont) {
        String tag = tabooMap.get("tag").toString();
        if ("text".equals(tag)) {
            if (Objects.isNull(tabooMap.get("content"))) return;
            String content = tabooMap.get("content").toString();
            tabooContentCell.setPhrase(new Phrase(content.toString(), new Font(zhFont)));
        }

        if ("img".equals(tag)) {
            if (Objects.isNull(tabooMap.get("content"))) return;
            String base64String = tabooMap.get("content").toString();
            try {
                // 移除Base64数据前缀 "data:image/jpeg;base64," 或其他格式的前缀，如果你的字符串包含这些的话
                base64String = base64String.replaceAll("^(data:image/.*;base64,)", "");
                // Base64解码
                byte[] imageBytes = Base64.getDecoder().decode(base64String);
                Image image = Image.getInstance(imageBytes);
                //添加图片
                image.setBackgroundColor(BaseColor.WHITE);
                image.setAlignment(1);
                image.scaleToFit(500, 500);
                tabooContentCell.setImage(image);
            } catch (Exception e) {
                System.err.println("转换图片时发生错误: " + e.getMessage());
            }
        }
    }

    private void assembleListDataCopy(Map<String, Object> map, PdfPCell cell, BaseFont zhFont) {
        String tag = map.get("tag").toString();
        if ("text".equals(tag)) {
            if (Objects.isNull(map.get("content"))) return;
            String content = map.get("content").toString();
            content = wiffOfContent(content, "<br>", "");
            content = wiffOfContent(content, "</br>", "");
            Phrase resPar = new Phrase("", EvimedPdfFont.TEXT);
            resPar.add(content);
            cell.setPhrase(resPar);
            cell.setPaddingBottom(4f);
            cell.setLeading(0f, 1.2f);
        }

        if ("img".equals(tag)) {
            if (Objects.isNull(map.get("content"))) return;
            String base64String = map.get("content").toString();
            try {
                // 移除Base64数据前缀 "data:image/jpeg;base64," 或其他格式的前缀，如果你的字符串包含这些的话
                base64String = base64String.replaceAll("^(data:image/.*;base64,)", "");
                // Base64解码
                byte[] imageBytes = Base64.getDecoder().decode(base64String);
                Image image = Image.getInstance(imageBytes);
                //添加图片
                image.setBackgroundColor(BaseColor.WHITE);
                image.setAlignment(1);
                image.scaleToFit(500, 500);
                cell.setImage(image);
            } catch (Exception e) {
                System.err.println("转换图片时发生错误: " + e.getMessage());
            }
        }
    }

    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) return "";
        content = content.replaceAll(oldChar, newChar);
        return content;
    }

}

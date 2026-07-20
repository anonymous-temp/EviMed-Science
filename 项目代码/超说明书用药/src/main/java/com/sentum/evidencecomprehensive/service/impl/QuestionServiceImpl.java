package com.sentum.evidencecomprehensive.service.impl;

import com.alibaba.fastjson.JSONObject;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.feign.SystemFeign;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.*;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.bo.EvidenceBasedReport;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;
import com.sentum.evidencecomprehensive.pojo.vo.QuestionUpdateVo;
import com.sentum.evidencecomprehensive.pojo.vo.QuestionVo;
import com.sentum.evidencecomprehensive.service.MailService;
import com.sentum.evidencecomprehensive.service.QuestionService;
import com.sentum.evidencecomprehensive.utils.FormatUtil;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

import javax.servlet.http.HttpServletRequest;
import java.util.*;

@Slf4j
@Service
public class QuestionServiceImpl implements QuestionService {
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private SystemFeign systemFeign;
    @Autowired
    private MailService mailService;

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
            if (CollectionUtils.isNotEmpty(drugs)){
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
            if (CollectionUtils.isNotEmpty(diseases)){
                name.append("治疗");
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
    public Boolean updateName(QuestionUpdateVo questionUpdateVo) {
        Update update = new Update();
        update.set("name", questionUpdateVo.getName());
        update.set("updateTime", System.currentTimeMillis());
        UpdateResult updateResult = mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(questionUpdateVo.getId())), update, Question.class);
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
//        //1-全部课题；2-我的课题；3-收藏课题；4-分享课题
//        List<Criteria> criteriaList = new ArrayList<>();
//        switch (type) {
//            case 1:
//                criteriaList.add(Criteria.where("userId").is(userId));
//                break;
//            case 2:
//                criteriaList.add(Criteria.where("createUserId").is(userId));
//                break;
//            case 3:
//                criteriaList.add(Criteria.where("userId").is(userId));
//                criteriaList.add(Criteria.where("collectStatus").is(1));
//                break;
//            case 4:
//                criteriaList.add(Criteria.where("userId").is(userId));
//                criteriaList.add(Criteria.where("createUserId").ne(userId));
//                break;
//            default:
//                criteriaList.add(Criteria.where("userId").is(userId));
//                break;
//        }
//        if (StringUtils.isNotBlank(search)){
//            criteriaList.add(Criteria.where("name").regex(search, "i"));
//        }
//        //判断是超说明书还是循证、中兴
//        criteriaList.add(Criteria.where("type").is(belongTo(request)));
//        Criteria criteria = new Criteria();
//        criteria.andOperator(criteriaList.toArray(new Criteria[0]));
//        Query query = new Query(criteria);
//        long total = mongoTemplate.count(query, Question.class);
//        int pages = (int) (total % pageSize == 0 ? total / pageSize : total / pageSize + 1);
//        query.with(PageRequest.of(pageNum - 1, pageSize));
//        String sortName = "";
//        if (sortType == 1) {
//            sortName = "createTime";
//        } else if (sortType == 2) {
//            sortName = "updateTime";
//        } else {
//            //默认顺序按照创建时间倒叙
//            query.with(Sort.by(Sort.Direction.DESC, "createTime"));
//        }
//        if (StringUtils.isNotBlank(sortName)) {
//            if (direction == 1) {
//                query.with(Sort.by(Sort.Direction.ASC, sortName));
//            } else {
//                query.with(Sort.by(Sort.Direction.DESC, sortName));
//            }
//        }
//        List<Question> questions = mongoTemplate.find(query, Question.class);
//        List<QuestionVo> list = new ArrayList<>();
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
                    String userName = data.getString("userName");
                    if (StringUtils.isBlank(userName)) {
                        userName = data.getString("loginName");
                    }
                    if (StringUtils.isNotBlank(userName)) {
                        createName = userName;
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
            JSONObject report = mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
            questionVo.setExists(!Objects.isNull(report));
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
//        Question pQuestion = mongoTemplate.findById(id, Question.class);
//        if (pQuestion != null) {
//            Question question = new Question();
//            String pId = pQuestion.getPId();
//            if ("-1".equals(pId)) {
//                pId = id;
//            }
//            BeanUtils.copyProperties(pQuestion, question);
//            question.setPId(pId);
//            String newId = UUID.randomUUID().toString();
//            question.setId(newId);
//            long timeMillis = System.currentTimeMillis();
//            question.setUpdateTime(timeMillis);
//            question.setCreateTime(timeMillis);
//            question.setUserId(question.getUserId());
//            question.setCreateUserId(question.getUserId());
//            question.setCollectStatus(question.getCollectStatus());
//            String name = pQuestion.getName();
//            Integer historyNum = pQuestion.getHistoryNum();
//            question.setName(name + "-" + historyNum);
//            //将原来数据的historyNum+1
//            historyNum = historyNum + 1;
//            question.setHistoryNum(historyNum);
//            Update update = new Update();
//            update.set("historyNum", historyNum);
//            update.set("updateTime", timeMillis);
//            try {
//                mongoTemplate.save(question);
//                mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(id)), update, Question.class);
//                Question pQuestion11 = mongoTemplate.findById(id, Question.class);
//                //只保留最新的3个历史记录
//                List<Question> questions = mongoTemplate.find(new Query(Criteria.where("pId").is(pId)).with(Sort.by(Sort.Direction.DESC, "updateTime")), Question.class);
//                if (questions.size() > 3) {
//                    List<String> deleteIds = new ArrayList<>();
//                    for (int i = 3; i < questions.size(); i++) {
//                        deleteIds.add(questions.get(i).getId());
//                    }
//                    mongoTemplate.remove(new Query(Criteria.where("_id").in(deleteIds)), Question.class);
//                }
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
                if (CollectionUtils.isNotEmpty(paperQualities)) {
                    List<PaperQuality> newPaperQualities = new ArrayList<>();
                    paperQualities.forEach(paperQuality -> {
                        paperQuality.setId(UUID.randomUUID().toString());
                        paperQuality.setConditionId(newId);
                        paperQuality.setUserId(paperQuality.getUserId());
                        newPaperQualities.add(paperQuality);
                    });
                    mongoTemplate.insert(newPaperQualities, PaperQuality.class);
                }
                //复制文献纳排
                List<PaperIncludeOrExclude> includeOrExcludeList = mongoTemplate.find(query, PaperIncludeOrExclude.class);
                if (CollectionUtils.isNotEmpty(includeOrExcludeList)){
                    List<PaperIncludeOrExclude> newIncludeOrExcludeList = new ArrayList<>();
                    includeOrExcludeList.forEach(paperIncludeOrExclude -> {
                        paperIncludeOrExclude.setId(UUID.randomUUID().toString());
                        paperIncludeOrExclude.setConditionId(newId);
                        paperIncludeOrExclude.setUserId(paperIncludeOrExclude.getUserId());
                        newIncludeOrExcludeList.add(paperIncludeOrExclude);
                    });
                    mongoTemplate.insert(newIncludeOrExcludeList, PaperIncludeOrExclude.class);
                }
                //复制指南纳排
                List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(query, GuideIncludeOrExclude.class);
                if (CollectionUtils.isNotEmpty(guideIncludeOrExcludes)) {
                    List<GuideIncludeOrExclude> newGuideIncludeOrExcludes = new ArrayList<>();
                    guideIncludeOrExcludes.forEach(guideIncludeOrExclude -> {
                        guideIncludeOrExclude.setId(UUID.randomUUID().toString());
                        guideIncludeOrExclude.setConditionId(newId);
                        guideIncludeOrExclude.setUserId(guideIncludeOrExclude.getUserId());
                        newGuideIncludeOrExcludes.add(guideIncludeOrExclude);
                    });
                    mongoTemplate.insert(newGuideIncludeOrExcludes, GuideIncludeOrExclude.class);
                }
                //复制临床试验纳排
                List<ClinicalTrialsIncludeOrExclude> clinicalTrialsIncludeOrExcludes = mongoTemplate.find(query, ClinicalTrialsIncludeOrExclude.class);
                if (CollectionUtils.isNotEmpty(clinicalTrialsIncludeOrExcludes)) {
                    List<ClinicalTrialsIncludeOrExclude> newClinicalTrialsIncludeOrExcludes = new ArrayList<>();
                    clinicalTrialsIncludeOrExcludes.forEach(clinicalTrialsIncludeOrExclude -> {
                        clinicalTrialsIncludeOrExclude.setId(UUID.randomUUID().toString());
                        clinicalTrialsIncludeOrExclude.setConditionId(newId);
                        clinicalTrialsIncludeOrExclude.setUserId(clinicalTrialsIncludeOrExclude.getUserId());
                        newClinicalTrialsIncludeOrExcludes.add(clinicalTrialsIncludeOrExclude);
                    });
                    mongoTemplate.insert(newClinicalTrialsIncludeOrExcludes, ClinicalTrialsIncludeOrExclude.class);
                }
                //复制报告
                EvidenceBasedReport evidenceBasedReport = mongoTemplate.findById(id, EvidenceBasedReport.class, "evidence_Based_Report");
                if (evidenceBasedReport != null) {
                    evidenceBasedReport.setId(newId);
                    mongoTemplate.save(evidenceBasedReport, "evidence_Based_Report");
                }
                //复制超说明书报告
                JSONObject report = mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
                if (report != null) {
                    report.put("_id", newId);
                    mongoTemplate.save(report, "super_manual_Report");
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
            if (CollectionUtils.isNotEmpty(paperQualities)) {
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
            if (CollectionUtils.isNotEmpty(includeOrExcludeList)){
                List<PaperIncludeOrExclude> newIncludeOrExcludeList = new ArrayList<>();
                includeOrExcludeList.forEach(paperIncludeOrExclude -> {
                    paperIncludeOrExclude.setId(UUID.randomUUID().toString());
                    paperIncludeOrExclude.setConditionId(newId);
                    paperIncludeOrExclude.setUserId(userId);
                    paperIncludeOrExclude.setStatus(1);
                    newIncludeOrExcludeList.add(paperIncludeOrExclude);
                });
                mongoTemplate.insert(newIncludeOrExcludeList, PaperIncludeOrExclude.class);
            }
            //复制指南纳排
            List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(query, GuideIncludeOrExclude.class);
            if (CollectionUtils.isNotEmpty(guideIncludeOrExcludes)) {
                List<GuideIncludeOrExclude> newGuideIncludeOrExcludes = new ArrayList<>();
                guideIncludeOrExcludes.forEach(guideIncludeOrExclude -> {
                    guideIncludeOrExclude.setId(UUID.randomUUID().toString());
                    guideIncludeOrExclude.setConditionId(newId);
                    guideIncludeOrExclude.setUserId(userId);
                    guideIncludeOrExclude.setStatus(1);
                    newGuideIncludeOrExcludes.add(guideIncludeOrExclude);
                });
                mongoTemplate.insert(newGuideIncludeOrExcludes, GuideIncludeOrExclude.class);
            }
            //复制临床试验纳排
            List<ClinicalTrialsIncludeOrExclude> clinicalTrialsIncludeOrExcludes = mongoTemplate.find(query, ClinicalTrialsIncludeOrExclude.class);
            if (CollectionUtils.isNotEmpty(clinicalTrialsIncludeOrExcludes)) {
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
            JSONObject superManualReport = mongoTemplate.findById(tarId, JSONObject.class, "super_manual_Report");
            if (superManualReport != null) {
                superManualReport.put("_id", newId);
                mongoTemplate.save(superManualReport, "super_manual_Report");
            }
            return true;
        }
        return false;
    }

    @Override
    public Integer determine(String id) {
        return 2;
//        JSONObject super_manual_report = mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
//        if (Objects.nonNull(super_manual_report)) {
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
        //超说明书
        List<String> offlabel = new ArrayList<>(Arrays.asList("http://192.168.20.252:2032/", "https://syshospital-offlabel.evimed.com/", "http://syshospital-offlabel.evimed.com/"));
        //循证
        List<String> zwhta = new ArrayList<>(Arrays.asList("http://192.168.20.252:2027/", "https://zwhta.evimed.com/", "http://zwhta.evimed.com/"));
        String referer = request.getHeader("referer");
        String origin = request.getHeader("origin");
        if (Objects.isNull(referer) && Objects.nonNull(origin)) referer = origin;
        int typeFlag = 3;
        if (Objects.nonNull(referer)) {
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
            if (typeFlag == 3) {
                for (String s : zwhta) {
                    if (referer.contains(s)){
                        typeFlag = 1;
                        break;
                    }
                }
            }
        }
        return typeFlag;
    }
}

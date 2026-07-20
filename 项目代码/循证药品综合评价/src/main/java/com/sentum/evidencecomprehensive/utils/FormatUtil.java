package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.util.StrUtil;
import com.sentum.evidencecomprehensive.domain.es.GuideIndex;
import com.sentum.evidencecomprehensive.domain.es.InstructionIndex;
import com.sentum.evidencecomprehensive.domain.es.ThreeClinicalIndex;
import com.sentum.evidencecomprehensive.domain.mongo.ClinicalTrialRegistration;
import com.sentum.evidencecomprehensive.domain.mongo.MailInfo;
import com.sentum.evidencecomprehensive.domain.mongo.MongoLiterature;
import com.sentum.evidencecomprehensive.domain.mongo.Question;
import com.sentum.evidencecomprehensive.domain.vo.*;
import com.sentum.evidencecomprehensive.domain.vo.resp.ClinicalTrialsResponse;
import com.sentum.evidencecomprehensive.domain.vo.resp.GuideResponse;
import com.sentum.evidencecomprehensive.domain.vo.resp.PaperResponse;
import com.sentum.evidencecomprehensive.domain.vo.resp.ThreeClinicalTrialsResponse;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang3.StringUtils;

import java.util.*;
import java.util.stream.Collectors;

/**
 * 将数据库中的数据转化为vo类
 * @author zgm
 */
@Slf4j
public class FormatUtil {

    /**
     * 规范文献vo数据
     * @param mongoLiterature 数据库中文献数据
     * @return 文献的vo
     */
    public static PaperResponse formatPaper(MongoLiterature mongoLiterature){
        PaperResponse paperResponse = new PaperResponse();
        
        paperResponse.setId(mongoLiterature.getId());
        
        if (StringUtils.isNotBlank(mongoLiterature.getTitle())){
            String title = mongoLiterature.getTitle();
            if (title.startsWith("[")){
                title = title.replaceAll("\\[", "").replaceAll("]", "");
            }
            paperResponse.setTitle(title);
        }
        //summary
        if (StringUtils.isNotBlank(mongoLiterature.getSummary())){
            paperResponse.setSummary(mongoLiterature.getSummary());
        }
        //year
        if (StringUtils.isNotBlank(mongoLiterature.getYear())){
            paperResponse.setYear(mongoLiterature.getYear());
        }

        //journal
        if (StringUtils.isNotBlank(mongoLiterature.getFullJournal())){
            paperResponse.setJournal(mongoLiterature.getFullJournal());
        }else {
            String journal = mongoLiterature.getJournal();
            if (StringUtils.isNotEmpty(journal)){
                paperResponse.setJournal(journal);
            }
        }

        //author
        List<String> authorResultList = new ArrayList<>();
        List<String> authorList = mongoLiterature.getAuthor();
        if (CollUtil.isNotEmpty(authorList)){
            for (String s : authorList) {
                if (StringUtils.isNotBlank(s)){
                    authorResultList.add(s);
                }
            }
        }
        paperResponse.setAuthor(authorResultList);

        // type 文献所属类型
        List<Integer> lastNewType = mongoLiterature.getLastNewType();
        if (CollUtil.isNotEmpty(lastNewType)) {
            paperResponse.setType(lastNewType);
            List<String> zhNameTypes = new ArrayList<>();
            for (Integer type : lastNewType) {
                switch (type) {
                    case 0:
                        zhNameTypes.add("系统综述/Meta分析");
                        continue;
                    case 1:
                        zhNameTypes.add("传统综述");
                        continue;
                    case 2:
                        zhNameTypes.add("随机对照试验");
                        continue;
                    case 3:
                        zhNameTypes.add("队列研究");
                        continue;
                    case 4:
                        zhNameTypes.add("病例对照研究");
                        continue;
                    case 5:
                        zhNameTypes.add("横断面研究");
                        continue;
                    case 6:
                        zhNameTypes.add("病例系列");
                        continue;
                    case 7:
                        zhNameTypes.add("病例报告");
                        continue;
                    case 8:
                        zhNameTypes.add("专家意见和评价");
                        continue;
                    case 9:
                        zhNameTypes.add("动物实验");
                        continue;
                    case 10:
                        zhNameTypes.add("体外实验");
                        continue;
                    case 11:
                        zhNameTypes.add("指南/共识");
                        continue;
                    case 12:
                        zhNameTypes.add("经济学研究");
                        continue;
                    case 13:
                        zhNameTypes.add("其他");
                        continue;
                    case 14:
                        zhNameTypes.add("临床试验");
                        continue;
                    default:
                        break;
                }
            }
            if (CollUtil.isNotEmpty(mongoLiterature.getType())) {
                for (Integer type : mongoLiterature.getType()) {
                    if (type == 7) {
                        zhNameTypes.add("临床试验");
                    }
                }
            }
            paperResponse.setZhNameType(zhNameTypes.stream().distinct().collect(Collectors.toList()));
        }
        
        //language
        String language = mongoLiterature.getLanguage();
        if ("en".equals(language)){
            //英文jcr
            if (mongoLiterature.getJcr() != null){
                if (mongoLiterature.getJcr() != -1){
                    paperResponse.setJcr(String.valueOf(mongoLiterature.getJcr()));
                }
            }
            paperResponse.setLanguage(true);
        }else {
            if (mongoLiterature.getJcr() != null){
                List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
                if (CollUtil.isNotEmpty(recognizedKernelJournals)){
                    String s = recognizedKernelJournals.get(0);
                    switch (s){
                        case "Technology":
                            paperResponse.setJcr("科技核心");
                            break;
                        case "Peking University":
                            paperResponse.setJcr("北大核心");
                            break;
                        case "Nanjing University":
                            paperResponse.setJcr("南大核心");
                        case "CSCD":
                            paperResponse.setJcr("CSCD");
                            break;
                        default:
                            break;
                    }
                }
            }
            paperResponse.setLanguage(false);
        }
        //中文文献分区
        List<String> partition = new ArrayList<>();
        if ("zh".equals(language)){
            List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
            if (CollUtil.isNotEmpty(recognizedKernelJournals)){
                for (String recognizedKernelJournal : recognizedKernelJournals) {
                    switch (recognizedKernelJournal){
                        case "Technology":
                            partition.add("科技核心");
                            break;
                        case "Peking University":
                            partition.add("北大核心");
                            break;
                        case "Nanjing University":
                            partition.add("南大核心");
                            break;
                        case "CSCD":
                            partition.add("CSCD");
                            break;
                        default:
                            break;
                    }
                }
            }
        }
        paperResponse.setPartition(partition);

        //英文文献分区显示
        List<Map<String, Object>> englishPartition = new ArrayList<>();
        Set<String> levelSet = new HashSet<>();
        if ("en".equals(language)){
            List<String> journalDivision = mongoLiterature.getJournalDivision();
            if (CollUtil.isNotEmpty(journalDivision)){
                for (String s : journalDivision) {
                    String[] split = s.split("-");
                    if (split.length == 2){
                        Map<String, Object> inner = new HashMap<>();
                        String value = split[0].trim();
                        String name = split[1].trim();
                        inner.put("name", name);
                        inner.put("value", value);
                        inner.put("flag", false);
                        englishPartition.add(inner);

                        String substring_1 = "";
                        try {
                            substring_1 = name.substring(name.lastIndexOf("Q"));
                        } catch (Exception e) {
                           try {
                               substring_1 = name.substring(name.lastIndexOf("N"));
                           } catch (Exception e1) {
                               log.error(e.getMessage(), e);
                           }
                        }
                        String substring = substring_1.substring(0, substring_1.indexOf(")"));
                        levelSet.add(substring);
                    }
                }
            }
        }
        if (CollectionUtils.isNotEmpty(levelSet)) {
            //Comparator.reverseOrder()
            List<String> sortByLevel = levelSet.stream().sorted().collect(Collectors.toList());
            List<String> enJournal = sortByLevel.stream().map(l -> "JCR (" + l + ")").collect(Collectors.toList());
            paperResponse.setEnPartition(enJournal);
//            paperVo.setEnPartition(Collections.singletonList("JCR (" + sortByLevel.get(0) + ")"));
        }  else {
            paperResponse.setEnPartition(new ArrayList<>());
        }
//        paperResponse.setEnglishPartition(englishPartition);

        //文献质量Quality
        if (mongoLiterature.getQuality() != null) {
            paperResponse.setQuality(mongoLiterature.getQuality());
        }
        //原文链接
        if (StringUtils.isNotBlank(mongoLiterature.getMainUrl())){
            paperResponse.setMainUrl(mongoLiterature.getMainUrl());
            if (StrUtil.isNotBlank(mongoLiterature.getLanguage()) && "zh".equals(mongoLiterature.getLanguage())) {
                paperResponse.setMainUrl("");
            }
        }
        //pdf链接
        String pdfName = mongoLiterature.getPdfName();
        if (StringUtils.isNotBlank(pdfName)){
            if (pdfName.contains("www.www")) {
                pdfName = pdfName.replace("www.www", "www");
            }
            paperResponse.setPdfUrl(pdfName);
            if (StrUtil.isNotBlank(mongoLiterature.getLanguage()) && "zh".equals(mongoLiterature.getLanguage())) {
                paperResponse.setPdfUrl("");
            }
        }
        //文献来源
        List<String> source = new ArrayList<>();
        List<String> allSource = new ArrayList<>(Arrays.asList("WANGFANG", "CBM", "CNKI", "CQVIP", "embase", "Cochrane", "Pubmed"));
        List<String> belong = mongoLiterature.getBelong();
        if (CollUtil.isNotEmpty(belong)) {
            for (String s : belong) {
                if (allSource.contains(s)) {
                    source.add(s);
                }
            }
        }
        paperResponse.setSource(source);

        Set<String> set = new LinkedHashSet<>(paperResponse.getSource());
        if(StringUtils.isNotBlank(mongoLiterature.getDupBelongNums())){
            try {
                String[] belongs = mongoLiterature.getDupBelongNums().split(";");
                for (String b : belongs) {
                    if (allSource.contains(b.split(",")[0])) {
                        set.add(b.split(",")[0]);
                    }
                }
            }catch (Exception e){
                log.error(e.getMessage(),e);
            }
        }
        paperResponse.setSource(new ArrayList<>(set));
        return paperResponse;
    }

    /**
     * 规范指南vo数据
     * @param guideIndex 数据库中查询到的指南数据
     * @return 指南的vo
     */
    public static GuideResponse formatGuide(GuideIndex guideIndex) {
        GuideResponse guideResponse = new GuideResponse();
        String id = guideIndex.getId();
        guideResponse.setId(id);
        //标题
        String title = guideIndex.getTitle();
        if (StringUtils.isNotBlank(title)){
            guideResponse.setTitle(title);
        }
        //发表时间
        String fbdate = guideIndex.getFbdate();
        if (StringUtils.isNotBlank(fbdate)){
            guideResponse.setDate(fbdate);
        }
        //制定者
        String zdz = guideIndex.getZdz();
        if (StringUtils.isNotBlank(zdz)){
            guideResponse.setAuthor(zdz);
        }
        //指南语言类型
        String language = guideIndex.getLanguage();
        if (StringUtils.isNotBlank(language)){
            guideResponse.setLanguage(language);
        }
        //指南得分
        String score = guideIndex.getScore();
        if (StringUtils.isNotBlank(score)){
            guideResponse.setScore(score);
        }
        //指南简介
        String nrjs = guideIndex.getNrjs();
        if (StringUtils.isNotBlank(nrjs)){
            guideResponse.setSummary(nrjs);
        }
        //判断是否是指南
        Integer isPaper = guideIndex.getIsPaper();
        if (Objects.nonNull(isPaper)){
            guideResponse.setIsPaper(isPaper);
        }
        return guideResponse;
    }

    /**
     * 规范说明书vo数据
     * @param instructionIndex 数据库中查询到的说明书数据
     * @return 说明书的vo
     */
    public static InstructionVo formInstruction(InstructionIndex instructionIndex) {
        InstructionVo instructionVo = new InstructionVo();
        //说明书标准名称-中文
        String simpleGenericNames = instructionIndex.getSimpleGenericNames();
        if (StringUtils.isNotBlank(simpleGenericNames)){
            instructionVo.setSimpleGenericName(simpleGenericNames);
        }
        //说明书标准名称-英文
        String simpleEnglishName = instructionIndex.getSimpleEnglishName();
        if (StringUtils.isNotBlank(simpleEnglishName)){
            instructionVo.setSimpleEnglishName(simpleEnglishName);
        }
        //说明书商品名称
        String getTradeNames = instructionIndex.getTradeNames();
        if (StringUtils.isNotBlank(getTradeNames)){
            instructionVo.setSimpleTradeName(getTradeNames);
        }
        //说明书的适应症
        String indication = instructionIndex.getIndication();
        if (StringUtils.isNotBlank(indication)){
            instructionVo.setIndication(indication);
        }
        //厂家名称
        String enterpriseName = instructionIndex.getEnterpriseName();
        if (StringUtils.isNotBlank(enterpriseName)){
            instructionVo.setEnterpriseName(enterpriseName);
        }
        //说明书发表日期
        String revisionDate = instructionIndex.getRevisionDate();
        if (StringUtils.isNotBlank(revisionDate)){
            instructionVo.setDate(revisionDate);
        }
        //说明书发表日期
        String specifications = instructionIndex.getSpecifications();
        if (StringUtils.isNotBlank(specifications)){
            instructionVo.setSpecifications(specifications);
        }
        //说明书来源
        
        String source = instructionIndex.getSource();
        if (StringUtils.isNotBlank(source)){
            List<String> list = new ArrayList<>(Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药"));
            if (list.contains(source)) {
                instructionVo.setSource("nmpa");
                if ("nmpa".equals(source)) instructionVo.setSecondarySource("灵犀说明书库");
            } else {
                instructionVo.setSource(source);
            }
        }
        //pdf
        String pdfName = instructionIndex.getPdf_name();
        if (StringUtils.isNotBlank(pdfName)){
            instructionVo.setPdfName(pdfName);
        }
        //修订日期
        if (StringUtils.isNotBlank(revisionDate) && !"0".equals(revisionDate)){
            instructionVo.setUpdateTime(revisionDate);
        }

        Boolean medicineUsePdf = instructionIndex.getMedicineUsePdf();
        if (Objects.isNull(medicineUsePdf)) {
            medicineUsePdf = false;
        }
        instructionVo.setMedicineUsePdf(medicineUsePdf);
        
        return instructionVo;
    }

    /**
     * 规范改版临床试验vo数据
     * @param registration 数据库中查询到的临床试验数据
     * @return 说明书的vo
     */
    public static ThreeClinicalTrialsResponse formClinicalTrials(ThreeClinicalIndex registration) {
        ThreeClinicalTrialsResponse threeClinicalTrialsResponse = new ThreeClinicalTrialsResponse();

        String id = registration.getId();
        if (StrUtil.isNotBlank(id)) {
            threeClinicalTrialsResponse.setId(id);
        }        
        String cochraneId = registration.getCochraneId();
        if (StrUtil.isNotBlank(cochraneId)) {
            threeClinicalTrialsResponse.setCochraneId(cochraneId);
        }

        String title = registration.getTitle();
        if (StrUtil.isNotBlank(title)) {
            threeClinicalTrialsResponse.setTitle(title);
        }

        String year = registration.getYear();
        if (StrUtil.isNotBlank(year)) {
            threeClinicalTrialsResponse.setYear(year);
        }
        
        List<String> keyword = registration.getKeyword();
        if (CollUtil.isNotEmpty(keyword)) {
            threeClinicalTrialsResponse.setKeyword(keyword);
        }
        
        return threeClinicalTrialsResponse;
    }


    /**
     * 规范临床试验vo数据
     * @param registration 数据库中查询到的临床试验数据
     * @return 说明书的vo
     */
    public static ClinicalTrialsResponse formClinicalTrials(ClinicalTrialRegistration registration) {
        ClinicalTrialsResponse clinicalTrialsResponse = new ClinicalTrialsResponse();
        //登记号
        clinicalTrialsResponse.setRegisterNo(registration.getRegisterNo());
        //实验阶段
        clinicalTrialsResponse.setStudyPhase(registration.getStudyPhase());
        //临床试验的原文链接，who类型的临床试验需要单独解析原文链接
        String belong = registration.getBelong();
        clinicalTrialsResponse.setUrl("");
        if("chictr".equals(belong)){
            String registerUrl = registration.getRegisterUrl();
            if (StringUtils.isNotBlank(registerUrl)) {
                clinicalTrialsResponse.setUrl(registerUrl);
            }
        }else {
            clinicalTrialsResponse.setUrl("https://www.clinicaltrials.gov/ct2/show/" + registration.getRegisterNo());
        }
        //实验题目
        if (StringUtils.isNotBlank(registration.getPublicTitle())) {
            clinicalTrialsResponse.setPublicTitle(registration.getPublicTitle());
        }
        //招募状态
        clinicalTrialsResponse.setRecruitmentStatus("");
        if (StringUtils.isNotBlank(registration.getRecruitmentStatus())) {
            clinicalTrialsResponse.setRecruitmentStatus(registration.getRecruitmentStatus());
        }
        //注册时间
        clinicalTrialsResponse.setRegisterDate("");
        if (StringUtils.isNotBlank(registration.getRegisterDate())) {
            clinicalTrialsResponse.setRegisterDate(registration.getRegisterDate());
        }
        //样本量
        clinicalTrialsResponse.setSampleSize("");
        if("chictr".equals(belong)){
            List<Map<String, Object>> intervention = registration.getIntervention();
            if(CollUtil.isNotEmpty(intervention)){
                int sum = 0;
                for(Map<String, Object> map : intervention){
                    String string = map.get("sample_size").toString();
                    sum += Integer.parseInt(string);
                }
                clinicalTrialsResponse.setSampleSize(sum+"");
            }
        }else {
            clinicalTrialsResponse.setSampleSize(registration.getSampleSize());
        }
        //适应症
        clinicalTrialsResponse.setCondition(registration.getCondition());
        //干预措施
        List<String> instructionsList = new ArrayList<>();
        List<Map<String, Object>> intervention = registration.getIntervention();
        for (Map<String, Object> map : intervention) {
            if("chictr".equals(belong)){
                instructionsList.add(map.get("intervention").toString());
            } else {
                instructionsList.add(map.get("intervention_type") + ": " + map.get("intervention_name"));
            }
        }
        clinicalTrialsResponse.setIntervention(instructionsList);
        //关联文章
        List<Map<String, String>> referenceList = new ArrayList<>();
        List<Map<String, String>> reference = registration.getReference();
        if (CollUtil.isNotEmpty(reference)) {
            for (Map<String, String> map : reference) {
                Map<String, String> inner = new HashMap<>();
                String citation = map.get("citation");
                String pMid = map.get("PMID");
                inner.put("name", citation);
                inner.put("url", "https://pubmed.ncbi.nlm.nih.gov/" + pMid);
                referenceList.add(inner);
            }
        }
        //研究类型
        clinicalTrialsResponse.setStudyType(registration.getStudyType());
        
        // 实施单位
        clinicalTrialsResponse.setPrimarySponsor(registration.getPrimarySponsor());
        
        //是否有研究结果
        clinicalTrialsResponse.setStudyResults(registration.getStudyResults());
        
        clinicalTrialsResponse.setReference(referenceList);
        return clinicalTrialsResponse;
    }

    /**
     * 规范课题vo数据
     * @param question 数据库中课题数据
     * @return 课题的vo
     */
    public static QuestionVo formQuestion(Question question) {
        QuestionVo questionVo = new QuestionVo();
        //id
        questionVo.setId(question.getId());
        //name 课题名称
        questionVo.setName(question.getName());
        //createName 创建人
        //createTime 创建时间
        questionVo.setCreateTime(question.getCreateTime());
        //updateTime 最后修改时间
        questionVo.setUpdateTime(question.getUpdateTime());
        //collectStatus 收藏状态：1-收藏；0-未收藏
        if (question.getCollectStatus() != null) {
            questionVo.setCollectStatus(question.getCollectStatus());
        }
        if (StrUtil.isNotBlank(question.getRecommendLevel())) {
            questionVo.setRecommendLevel(question.getRecommendLevel());
        }
        if (StrUtil.isNotBlank(question.getEvidenceLevel())) {
            questionVo.setEvidenceLevel(question.getEvidenceLevel());
        }
        if (StrUtil.isNotBlank(question.getOldRecommendLevel())) {
            questionVo.setOldRecommendLevel(question.getOldRecommendLevel());
        }
        if (StrUtil.isNotBlank(question.getOldEvidenceLevel())) {
            questionVo.setOldEvidenceLevel(question.getOldEvidenceLevel());
        }
        //更新提示
        if (Objects.nonNull(question.getRenew())) {
            questionVo.setRenew(question.getRenew());
        } else {
            questionVo.setRenew(false);
        }
        return questionVo;
    }

    /**
     * 规范站内信vo数据
     * @param mailInfo 数据库中站内信数据
     * @return 课题的vo
     */
    public static MailVo formMail(MailInfo mailInfo) {
        MailVo mailVo = new MailVo();
        mailVo.setId(mailInfo.getId());
        mailVo.setInfo(mailInfo.getInfo());
        mailVo.setStatus(0);
        Integer status = mailInfo.getStatus();
        if (status != null) {
            mailVo.setStatus(status);
        }
        mailVo.setDateTime(DateUtil.format(new Date(mailInfo.getCreateTime()), "yyyy-MM-dd HH:mm:ss"));
        return mailVo;
    }
}
package com.sentum.drugsafe.utils;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.util.StrUtil;
import com.sentum.drugsafe.pojo.InstructionIndex;
import com.sentum.drugsafe.pojo.MongoLiterature;
import com.sentum.drugsafe.pojo.PaperVo;
import com.sentum.drugsafe.pojo.Vo.InstructionVo;

import lombok.extern.slf4j.Slf4j;
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
    public static PaperVo formatPaper(MongoLiterature mongoLiterature){
        PaperVo paperVo = new PaperVo();
        //id
        paperVo.setId(mongoLiterature.getId());
        //title
        if (StringUtils.isNotBlank(mongoLiterature.getTitle())){
            String title = mongoLiterature.getTitle();
            if (title.startsWith("[")){
                title = title.replaceAll("\\[", "").replaceAll("]", "");
            }
            paperVo.setTitle(title);
        }
        //summary
        if (StringUtils.isNotBlank(mongoLiterature.getSummary())){
            paperVo.setSummary(mongoLiterature.getSummary());
        }
        //year
        if (StringUtils.isNotBlank(mongoLiterature.getYear())){
            paperVo.setYear(mongoLiterature.getYear());
        }

        //journal
        if (StringUtils.isNotBlank(mongoLiterature.getFullJournal())){
            paperVo.setJournal(mongoLiterature.getFullJournal());
        }else {
            String journal = mongoLiterature.getJournal();
            if (StringUtils.isNotEmpty(journal)){
                paperVo.setJournal(journal);
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
        paperVo.setAuthor(authorResultList);

        // type 文献所属类型
        List<Integer> lastNewType = mongoLiterature.getLastNewType();
        if (CollUtil.isNotEmpty(lastNewType)) {
            paperVo.setType(lastNewType);
        }

        //language
        String language = mongoLiterature.getLanguage();
        if ("en".equals(language)){
            //英文jcr
            if (mongoLiterature.getJcr() != null){
                if (mongoLiterature.getJcr() != -1){
                    paperVo.setJcr(String.valueOf(mongoLiterature.getJcr()));
                }
            }
            paperVo.setLanguage(true);
        }else {
            if (mongoLiterature.getJcr() != null){
                List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
                if (CollUtil.isNotEmpty(recognizedKernelJournals)){
                    String s = recognizedKernelJournals.get(0);
                    switch (s){
                        case "Technology":
                            paperVo.setJcr("科技核心");
                            break;
                        case "Peking University":
                            paperVo.setJcr("北大核心");
                            break;
                        case "Nanjing University":
                            paperVo.setJcr("南大核心");
                        case "CSCD":
                            paperVo.setJcr("CSCD");
                            break;
                        default:
                            break;
                    }
                }
            }
            paperVo.setLanguage(false);
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
        paperVo.setPartition(partition);

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
        if (CollUtil.isNotEmpty(levelSet)) {
            //Comparator.reverseOrder()
            List<String> sortByLevel = levelSet.stream().sorted().collect(Collectors.toList());
            paperVo.setEnPartition(Collections.singletonList("JCR (" + sortByLevel.get(0) + ")"));
        }  else {
            paperVo.setEnPartition(new ArrayList<>());
        }
//        paperVo.setEnglishPartition(englishPartition);

        //文献质量Quality
        if (mongoLiterature.getQuality() != null) {
            paperVo.setQuality(mongoLiterature.getQuality());
        }
        //原文链接
        if (StringUtils.isNotBlank(mongoLiterature.getMainUrl())){
            paperVo.setMainUrl(mongoLiterature.getMainUrl());
            if (StrUtil.isNotBlank(mongoLiterature.getLanguage()) && "zh".equals(mongoLiterature.getLanguage())) {
                paperVo.setMainUrl("");
            }
        }
        //pdf链接
        String pdfName = mongoLiterature.getPdfName();
        if (StringUtils.isNotBlank(pdfName)){
            if (pdfName.contains("www.www")) {
                pdfName = pdfName.replace("www.www", "www");
            }
            paperVo.setPdfUrl(pdfName);
            if (StrUtil.isNotBlank(mongoLiterature.getLanguage()) && "zh".equals(mongoLiterature.getLanguage())) {
                paperVo.setPdfUrl("");
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
        paperVo.setSource(source);

        Set<String> set = new LinkedHashSet<>(paperVo.getSource());
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
        paperVo.setSource(new ArrayList<>(set));
        return paperVo;
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
//        //说明书商品名称
//        String simpleTradeNames = instructionIndex.getSimpleTradeNames();
//        if (StringUtils.isNotBlank(simpleTradeNames)){
//            instructionVo.setSimpleTradeName(simpleTradeNames);
//        }
        String tradeNames = instructionIndex.getTradeNames();
        if (StringUtils.isNotBlank(tradeNames)){
            instructionVo.setSimpleTradeName(tradeNames);
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
            if ("0".equals(revisionDate)){
                revisionDate = "";
            }
            instructionVo.setDate(revisionDate);
        }
        //说明书发表日期
        String specifications = instructionIndex.getSpecifications();
        if (StringUtils.isNotBlank(specifications)){
             if ("0".equals(specifications)){
                specifications = "";
            }
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
        if (StringUtils.isNotBlank(revisionDate)){
            instructionVo.setUpdateTime(revisionDate);
        }

        Boolean medicineUsePdf = instructionIndex.getMedicineUsePdf();
        if (Objects.isNull(medicineUsePdf)) {
            medicineUsePdf = false;
        }
        instructionVo.setMedicineUsePdf(medicineUsePdf);
        
        return instructionVo;
    }

}
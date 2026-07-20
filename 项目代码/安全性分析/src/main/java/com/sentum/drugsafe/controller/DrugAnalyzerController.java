package com.sentum.drugsafe.controller;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONObject;
import com.itextpdf.text.DocumentException;
import com.sentum.drugsafe.dto.FdaQueryCondition;
import com.sentum.drugsafe.dto.PubCollectDto;
import com.sentum.drugsafe.pojo.Dto.SurveyDto;
import com.sentum.drugsafe.pojo.FileInfoUploadDto;
import com.sentum.drugsafe.pojo.SearchCondition;
import com.sentum.drugsafe.pojo.SummaryContentVO;
import com.sentum.drugsafe.pojo.PicoResult;
import com.sentum.drugsafe.service.AlertService;
import com.sentum.drugsafe.service.DownloadService;
import com.sentum.drugsafe.service.DrugAnalyzerService;
import com.sentum.drugsafe.trans.DeeplApi;
import com.sentum.drugsafe.trans.RedisUtil;
import com.sentum.drugsafe.trans.TransUtil;
import com.sentum.drugsafe.trans.VerticalTransUtil;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.ObjectUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.scheduling.annotation.Async;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.CompletableFuture;

@Slf4j
@RestController
@RequestMapping("/alert/v2")
public class DrugAnalyzerController {

    @Autowired
    AlertService alertService;

    @Autowired
    DrugAnalyzerService drugAnalyzerService;

    @Autowired
    DownloadService downloadService;

    @Autowired
    MongoTemplate mongoTemplate;

    //问卷调查
    @ApiOperation(value = "用户自定义的进行问卷", notes = "用户自定义的进行问卷")
    @PostMapping("/survey")
    public PicoResult survey(@RequestBody SurveyDto surveyDto) {
        mongoTemplate.insert(surveyDto);
        return PicoResult.ok();
    }


    @ApiOperation(value = "用户输入查询条件查询", notes = "用户输入查询条件查询")
    @ApiImplicitParam(name = "query", value = "用户输入查询条件", required = true)
    @GetMapping("/search")
    public PicoResult search(@RequestParam String query, @RequestParam(required = false) String id, @RequestParam(required = false) String isApp, HttpServletRequest request) {
//        if(StrUtil.isBlank(id)) {
//            return PicoResult.data(this.drugAnalyzerService.search(query));
//        }
//        return PicoResult.data(this.drugAnalyzerService.getSynonymById(id));
        long startTime = System.currentTimeMillis();
        JSONObject search = this.drugAnalyzerService.search(query, isApp);
        long endTime = System.currentTimeMillis();
        log.info("搜索耗时：" + (endTime - startTime) + "ms");
        PicoResult data = PicoResult.data(search);
        return data;
    }


    @ApiOperation(value = "用户输入查询条件查询", notes = "用户输入查询条件查询")
    @PostMapping("/searchPlus")
    public PicoResult searchPlus(@RequestBody SearchCondition searchCondition) {
//        if(StrUtil.isBlank(id)) {
//            return PicoResult.data(this.drugAnalyzerService.search(query));
//        }
//        return PicoResult.data(this.drugAnalyzerService.getSynonymById(id));
        return PicoResult.data(this.drugAnalyzerService.searchPlus(searchCondition));
    }

    @ApiOperation(value = "通过不良反应查询药物", notes = "通过不良反应查询药物")
    @GetMapping("/drug/list")
    public PicoResult getDrugsByPt(@RequestParam String id, @RequestParam(required = false) String drugName, Integer sort, @RequestParam Integer pageNum, @RequestParam Integer pageSize, HttpServletRequest request) {
        PicoResult data = PicoResult.data(this.drugAnalyzerService.getDrugByPt(id, drugName, sort, pageNum, pageSize));



        return data;
    }


    @ApiOperation(value = "通过不良反应查询药物", notes = "通过不良反应查询药物")
    @GetMapping("/drug/list-jd")
    public PicoResult getDrugsByPtJd(@RequestParam String id, @RequestParam(required = false) String drugName, Integer sort, @RequestParam Integer pageNum, @RequestParam Integer pageSize, HttpServletRequest request) {
        PicoResult data = PicoResult.data(this.drugAnalyzerService.getDrugByPtJd(id, drugName, sort, pageNum, pageSize));

        return data;
    }

    @ApiOperation(value = "通过分词查询概览面板的查询条件", notes = "通过分词查询概览面板的查询条件")
    @GetMapping("/condition/query")
    public PicoResult getCondition(@RequestParam String id, String drugName) {
        return PicoResult.data(this.drugAnalyzerService.getFdaSearhConditon(id, drugName));
    }

    @ApiOperation(value = "通过分词查询概览面板的查询条件", notes = "通过分词查询概览面板的查询条件")
    @GetMapping("/condition/query-jd")
    public PicoResult getConditionJd(@RequestParam String id, String drugName) {
        return PicoResult.data(this.drugAnalyzerService.getFdaSearhConditonJd(id, drugName));
    }


    @ApiOperation(value = "查询fda页面", notes = "查询fda页面")
    @PostMapping("/fda/query")
    public PicoResult getfda(@RequestBody FdaQueryCondition fdaQueryCondition, HttpServletRequest request) {
        try {
            PicoResult data = PicoResult.data(this.drugAnalyzerService.getFda(fdaQueryCondition));



            return data;

        } catch (Exception e) {
            log.error(e.getMessage(), e);
            return PicoResult.data("");
        }
    }


    @ApiOperation(value = "查询fda页面", notes = "查询fda页面")
    @PostMapping("/fda/query-jd")
    public PicoResult getfdaJd(@RequestBody FdaQueryCondition fdaQueryCondition) {

            return PicoResult.data(this.drugAnalyzerService.getFdaJd(fdaQueryCondition));

    }


    @ApiOperation(value = "翻译", notes = "翻译")
    @GetMapping("/translate")
    public PicoResult translate(String str) {
        return PicoResult.data(DeeplApi.trans(str));
    }

    @ApiOperation(value = "保存同义词", notes = "保存同义词")
    @PostMapping("/synonym/save")
    public PicoResult saveSynonym(@RequestBody JSONObject jsonObject) {
        drugAnalyzerService.saveUserSynonym(jsonObject);
        return PicoResult.ok();
    }

    @ApiOperation(value = "报告", notes = "报告")
    @GetMapping("/report/query")
    public PicoResult getReport(String id, String drugName) {
        try {
            return PicoResult.data(this.drugAnalyzerService.getReport(id, drugName));
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            return PicoResult.error("没有找到相关报告信息");
        }
    }

    @ApiOperation(value = "报告", notes = "报告")
    @GetMapping("/report/query-jd")
    public PicoResult getReportJd(String id, String drugName) {
        try {
            return PicoResult.data(this.drugAnalyzerService.getReportJd(id, drugName));
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            return PicoResult.error("没有找到相关报告信息");
        }
    }


    @ApiOperation(value = "下载报告", notes = "下载报告")
    @GetMapping("/report/download")
    public void downloadReport(String id, String source, HttpServletResponse response) throws IOException, DocumentException, com.lowagie.text.DocumentException {
        downloadService.download(id, response, source);
    }

    @ApiOperation(value = "下载报告", notes = "下载报告")
    @GetMapping("/report/downloadApp-pdf")
    public void downloadReportPdf(String id, String drugName, String source, HttpServletResponse response) throws IOException, DocumentException, com.lowagie.text.DocumentException {
        JSONObject report = this.drugAnalyzerService.getReport(id, drugName);
        downloadService.guideDownloadPdf(id, response, source);
    }

    @ApiOperation(value = "下载报告", notes = "下载报告")
    @GetMapping("/report/download-jd")
    public void downloadReportJd(String id, String source, HttpServletResponse response) throws IOException, DocumentException, com.lowagie.text.DocumentException {
        JSONObject report = this.drugAnalyzerService.getReportJd(id, null);
        downloadService.downloadJd(id, response, source);
    }

    @ApiOperation(value = "下载报告", notes = "下载报告")
    @GetMapping("/report/downloadApp-jd-pdf")
    public void downloadReportJdPdf(String id, String drugName, String source, HttpServletResponse response) throws IOException, DocumentException, com.lowagie.text.DocumentException {
        JSONObject report = this.drugAnalyzerService.getReportJd(id, drugName);
        if (ObjectUtils.isNotEmpty(report)) {
            downloadService.guideDownloadJdPdf(id, response, source);
        } else {
            throw new RuntimeException("没有找到相关报告信息");
        }
    }

    @ApiOperation(value = "下载报告", notes = "下载报告")
    @GetMapping("/report/downloadApp-jd")
    public void downloadReportJdApp(String id, String drugName, String source, HttpServletResponse response) throws IOException, DocumentException, com.lowagie.text.DocumentException {
        downloadService.downloadJd(id, response, source);
    }

    @ApiOperation(value = "下载报告", notes = "下载报告")
    @GetMapping("/report/downloadApp")
    public void downloadReportApp(String id, String drugName, String source, HttpServletResponse response) throws IOException, DocumentException, com.lowagie.text.DocumentException {
        JSONObject report = this.drugAnalyzerService.getReport(id, drugName);
        if (ObjectUtils.isNotEmpty(report)) {
            downloadService.download(id, response, source);
        } else {
            throw new RuntimeException("没有找到相关报告信息");
        }

    }

    @ApiOperation(value = "概览", notes = "概览")
    @GetMapping("/summary")
    public PicoResult summary(@RequestParam String id) {
        try {
            return PicoResult.data(drugAnalyzerService.summary(id));
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            return PicoResult.error("没有找到相关信息");
        }
    }

    @ApiOperation(value = "保存概述", notes = "保存概述")
    @GetMapping("/summary/save")
    public PicoResult saveSummary(@RequestBody SummaryContentVO summaryContentVO) {
        drugAnalyzerService.saveSummary(summaryContentVO);
        return PicoResult.ok();
    }

    @ApiOperation(value = "临床试验", notes = "临床试验")
    @GetMapping("/cilinical/get")
    public PicoResult getClinical(@RequestParam String id) {
        return PicoResult.data(drugAnalyzerService.getCilinical(id));
    }

    @ApiOperation(value = "发布", notes = "发布")
    @PostMapping("/public")
    public PicoResult pub(FileInfoUploadDto fileInfoUploadDto) {
        return PicoResult.data(drugAnalyzerService.upload(fileInfoUploadDto));
    }


    @ApiOperation(value = "发布列表", notes = "发布列表")
    @GetMapping("/pub/list")
    public PicoResult pub(Integer pageNum, Integer pageSize, String searchInfo) {
        return PicoResult.data(drugAnalyzerService.listPub(searchInfo, pageNum, pageSize));
    }


    @ApiOperation(value = "收藏/取消收藏", notes = "收藏/取消收藏")
    @PostMapping("/pub/collect")
    public PicoResult collectPub(@RequestBody PubCollectDto pubCollectDto) {
        this.drugAnalyzerService.collectPub(pubCollectDto.getReleaseId(), pubCollectDto.isStatus());
        return PicoResult.ok();
    }

    @GetMapping("/adrs")
    public PicoResult adrs(String startDate) {
        CompletableFuture.runAsync(() -> drugAnalyzerService.adrs(startDate));
        return PicoResult.ok();
    }


}

package com.sentum.evidencecomprehensive.controller;

import com.alibaba.excel.EasyExcel;
import com.alibaba.excel.ExcelReader;
import com.alibaba.excel.read.metadata.ReadSheet;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.excel.bean.ReportBatchImportExcelBean;
import com.sentum.evidencecomprehensive.excel.listener.ReportImportExcelListener;
import com.sentum.evidencecomprehensive.excel.manager.ReportImportExcelManager;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.service.RetrievalService;
import com.sentum.evidencecomprehensive.service.SuperManualReportService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.util.Objects;
import java.util.concurrent.Executor;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/11/29
 */
@Slf4j
@Api(tags = "自用excelAPI")
@RestController
@RequestMapping("/evidence-api/excel")
public class SelfUseExcelController {

    @Autowired
    private ReportImportExcelManager selfUseImportExcelManager;
    @Autowired
    private RetrievalService retrievalService;
    @Autowired
    private SuperManualReportService superManualReportService;
    @Autowired
    private Executor excelExecutor;
    
    public static final String EXCEL_FILE_PATH = "自用excel";

    @Value("${local.excel.path}")
    private String localExcelPath;

    //####################  excel操作 #################################
    @ApiOperation(value = "selfUser 自用excel导入", notes = "excel")
    @PostMapping(value = "/report")
    public DataResult reportExcelExport(@RequestParam("upFile") MultipartFile file, HttpServletResponse response, HttpServletRequest request) {
        if (Objects.isNull(file)) {
            return DataResult.error("未选择导入文件！！！");
        }

        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }

        ExcelReader excelReader = null;
        try {
            ReportImportExcelListener listener = new ReportImportExcelListener(selfUseImportExcelManager, retrievalService, superManualReportService, userId, request, response, excelExecutor);
            excelReader = EasyExcel.read(file.getInputStream(), ReportBatchImportExcelBean.class, listener).build();
            ReadSheet readSheet = EasyExcel.readSheet(0).build();
            excelReader.read(readSheet);
        } catch (Exception ex) {
            log.error("Episode Excel Import Exception.", ex);
        } finally {
            if (Objects.nonNull(excelReader)) {
                excelReader.finish();
            }
        }
        return DataResult.ok();
    }
}

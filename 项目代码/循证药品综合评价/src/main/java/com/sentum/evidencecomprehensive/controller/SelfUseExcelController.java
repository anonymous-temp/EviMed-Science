package com.sentum.evidencecomprehensive.controller;

import cn.hutool.core.date.DateTime;
import cn.hutool.core.io.FileUtil;
import cn.hutool.extra.servlet.ServletUtil;
import com.alibaba.excel.EasyExcel;
import com.alibaba.excel.ExcelReader;
import com.alibaba.excel.read.metadata.ReadSheet;
import com.alibaba.excel.support.ExcelTypeEnum;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.excel.bean.MedicalBatchImportExcelBean;
import com.sentum.evidencecomprehensive.excel.bean.SelfUseBatchImportExcelBean;
import com.sentum.evidencecomprehensive.excel.listener.MedicaImportExcelListener;
import com.sentum.evidencecomprehensive.excel.listener.SelfUseImportExcelListener;
import com.sentum.evidencecomprehensive.excel.manager.SelfUseImportExcelManager;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.utils.ExcelResponseUtil;
import com.sentum.evidencecomprehensive.utils.operateyl.CommonUtil;
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

import javax.servlet.http.HttpServletResponse;
import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/11/29
 */
@Slf4j
@Api(tags = "自用excelAPI")
@RestController
@RequestMapping("/evidence-api-based/excel")
public class SelfUseExcelController {

    @Autowired
    private SelfUseImportExcelManager selfUseImportExcelManager;
    @Autowired
    private FineScreenFeign fineScreenFeign;
    
    public static final String EXCEL_FILE_PATH = "自用excel";

    @Value("${local.excel.path}")
    private String localExcelPath;

    //####################  excel操作 #################################
    @ApiOperation(value = "selfUser 自用excel导入", notes = "excel")
    @PostMapping(value = "/selfUser")
    public DataResult selfUseExcelExport(@RequestParam("upFile") MultipartFile file, HttpServletResponse response) {
        if (Objects.isNull(file)) {
            return DataResult.error("未选择导入文件！！！");
        }

        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyyMMdd", Locale.CHINA);
        ExcelReader excelReader = null;
        try {
            SelfUseImportExcelListener listener = new SelfUseImportExcelListener(selfUseImportExcelManager, fineScreenFeign);
            excelReader = EasyExcel.read(file.getInputStream(), SelfUseBatchImportExcelBean.class, listener).build();
            ReadSheet readSheet = EasyExcel.readSheet(0).build();
            excelReader.read(readSheet);

            // 数据信息
            List<SelfUseBatchImportExcelBean> data = listener.getData();

            try {
                // 先创建文件夹
                String userInfosTempFilePath = CommonUtil.removeSeparatorFromSuffix(localExcelPath).concat(Constants.PAD_LEFT_SLASH).concat(EXCEL_FILE_PATH).concat(Constants.PAD_LEFT_SLASH);
                FileUtil.del(userInfosTempFilePath);
                if (!FileUtil.exist(userInfosTempFilePath)) {
                    FileUtil.mkParentDirs(userInfosTempFilePath);
                    FileUtil.mkdir(userInfosTempFilePath);
                }
                ExcelResponseUtil.buildExcelFile(SelfUseBatchImportExcelBean.class, data, "自用数据", 10, "self-use", simpleDateFormat, userInfosTempFilePath);

                String localFilePath = "自用数据".concat("-").concat(simpleDateFormat.format(new DateTime())).concat(ExcelTypeEnum.XLSX.getValue());
                String localFile = userInfosTempFilePath.concat(localFilePath);
                response.setCharacterEncoding("UTF-8");
                // 设置响应头以指示浏览器下载 Excel 文件
                response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                response.setHeader("Content-Disposition", "attachment; filename=userInfo-export.xlsx");
                ServletUtil.write(response, new File(localFile));
            } catch (IOException e) {
                log.error(e.getMessage(), e);
            }

        } catch (Exception ex) {
            log.error("Episode Excel Import Exception.", ex);
        } finally {
            if (Objects.nonNull(excelReader)) {
                excelReader.finish();
            }
        }
        return DataResult.ok();
    }




    //####################  excel导入数据 #################################
    @ApiOperation(value = "医保数据 excel导入", notes = "medicaI")
    @PostMapping(value = "/medicaI")
    public DataResult medicalExcelExport(@RequestParam("upFile") MultipartFile file, HttpServletResponse response) {
        if (Objects.isNull(file)) {
            return DataResult.error("未选择导入文件！！！");
        }

        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyyMMdd", Locale.CHINA);
        ExcelReader excelReader = null;
        try {
            MedicaImportExcelListener listener = new MedicaImportExcelListener();
            excelReader = EasyExcel.read(file.getInputStream(), MedicalBatchImportExcelBean.class, listener).build();
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

package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateTime;
import cn.hutool.core.io.FileUtil;
import com.alibaba.excel.EasyExcel;
import com.alibaba.excel.support.ExcelTypeEnum;
import com.sentum.evidencecomprehensive.constants.Constants;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.List;

@Slf4j
@Component
public class ExcelResponseUtil {
    
    /**
     * 创建 Excel
     */
    public static void buildExcelFile(Class head, List data, String name, int type, String typeName, SimpleDateFormat simpleDateFormat, String tempFilePath) throws IOException {
        String filename = name.concat("_").concat(typeName).concat("_").concat(simpleDateFormat.format(new DateTime())).concat(ExcelTypeEnum.XLSX.getValue());
        filename = name.concat("-").concat(simpleDateFormat.format(new DateTime())).concat(ExcelTypeEnum.XLSX.getValue());
        File newFile = FileUtil.newFile(tempFilePath.concat(filename));
        newFile.createNewFile();
        // 生成 Excel 文件
        EasyExcel.write(newFile, head).sheet().doWrite(data);
    }
}

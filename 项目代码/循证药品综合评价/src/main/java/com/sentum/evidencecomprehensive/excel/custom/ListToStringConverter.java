package com.sentum.evidencecomprehensive.excel.custom;

import com.alibaba.excel.converters.Converter;
import com.alibaba.excel.enums.CellDataTypeEnum;
import com.alibaba.excel.metadata.CellData;
import com.alibaba.excel.metadata.GlobalConfiguration;
import com.alibaba.excel.metadata.property.ExcelContentProperty;

import java.util.List;

/**
 * Description: 将List转为String
 */
public class ListToStringConverter implements Converter<List<String>> {
    @Override
    public Class supportJavaTypeKey() {
        return List.class;
    }

    @Override
    public CellDataTypeEnum supportExcelTypeKey() {
        return null;
    }

    @Override
    public List<String> convertToJavaData(CellData cellData, ExcelContentProperty contentProperty, GlobalConfiguration globalConfiguration) throws Exception {
//        if (cellData == null || cellData.getStringValue() == null) {
//            return null;
//        }
//        return (List<String>) new CellData<List<String>>(StrUtil.split(cellData.getStringValue(), ","));
        return null;
    }
    
    @Override
    public CellData convertToExcelData(List<String> value, ExcelContentProperty contentProperty, GlobalConfiguration globalConfiguration) throws Exception {
        if (value == null || value.isEmpty()) {
            return null;
        }
        return new CellData<>(String.join(",", value));
    }
}

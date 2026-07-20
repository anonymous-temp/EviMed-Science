package com.sentum.evidencecomprehensive.excel.converter;

import com.sentum.evidencecomprehensive.domain.mongo.HtaReport;
import com.sentum.evidencecomprehensive.excel.bean.HtaExcelExportBean;
import org.mapstruct.Mapper;
import org.mapstruct.factory.Mappers;

/**
 * Description:
 */
@Mapper(config = BaseConverter.class)
public interface HtaBoToBeanConverter extends BaseBoBeanConverter<HtaReport, HtaExcelExportBean> {

    HtaBoToBeanConverter INSTANCE = Mappers.getMapper(HtaBoToBeanConverter.class);
}
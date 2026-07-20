package com.sentum.evidencecomprehensive.excel.converter;

import com.sentum.evidencecomprehensive.domain.es.GuideIndex;
import com.sentum.evidencecomprehensive.excel.bean.GuideExcelExportBean;
import org.mapstruct.Mapper;
import org.mapstruct.factory.Mappers;

/**
 * Description:
 */
@Mapper(config = BaseConverter.class)
public interface GuideBoToBeanConverter extends BaseBoBeanConverter<GuideIndex, GuideExcelExportBean> {

    GuideBoToBeanConverter INSTANCE = Mappers.getMapper(GuideBoToBeanConverter.class);
}
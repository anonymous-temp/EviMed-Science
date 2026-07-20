package com.sentum.evidencecomprehensive.excel.converter;

import com.sentum.evidencecomprehensive.excel.ClinicalBo;
import com.sentum.evidencecomprehensive.excel.bean.ClinicalExcelExportBean;
import org.mapstruct.Mapper;
import org.mapstruct.factory.Mappers;

/**
 * Description:
 */
@Mapper(config = BaseConverter.class)
public interface ClinicalBoToBeanConverter extends BaseBoBeanConverter<ClinicalBo, ClinicalExcelExportBean> {

    ClinicalBoToBeanConverter INSTANCE = Mappers.getMapper(ClinicalBoToBeanConverter.class);
}
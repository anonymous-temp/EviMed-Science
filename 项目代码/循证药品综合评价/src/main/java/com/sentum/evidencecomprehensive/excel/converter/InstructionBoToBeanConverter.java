package com.sentum.evidencecomprehensive.excel.converter;

import com.sentum.evidencecomprehensive.domain.mongo.DrugInfo;
import com.sentum.evidencecomprehensive.excel.bean.InstructionExcelExportBean;
import org.mapstruct.Mapper;
import org.mapstruct.factory.Mappers;

/**
 * Description:
 */
@Mapper(config = BaseConverter.class)
public interface InstructionBoToBeanConverter extends BaseBoBeanConverter<DrugInfo, InstructionExcelExportBean> {

    InstructionBoToBeanConverter INSTANCE = Mappers.getMapper(InstructionBoToBeanConverter.class);
}
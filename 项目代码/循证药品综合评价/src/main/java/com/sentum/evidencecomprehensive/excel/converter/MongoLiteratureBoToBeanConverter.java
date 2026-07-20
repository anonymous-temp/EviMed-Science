package com.sentum.evidencecomprehensive.excel.converter;

import com.sentum.evidencecomprehensive.domain.mongo.MongoLiterature;
import com.sentum.evidencecomprehensive.excel.bean.PaperExcelExportBean;
import org.mapstruct.Mapper;
import org.mapstruct.factory.Mappers;

/**
 * Description:
 */
@Mapper(config = BaseConverter.class)
public interface MongoLiteratureBoToBeanConverter extends BaseBoBeanConverter<MongoLiterature, PaperExcelExportBean> {

    MongoLiteratureBoToBeanConverter INSTANCE = Mappers.getMapper(MongoLiteratureBoToBeanConverter.class);
}
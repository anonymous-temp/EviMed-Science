package com.sentum.evidencecomprehensive.excel.converter.service;

import com.sentum.evidencecomprehensive.domain.es.CdeIndex;
import com.sentum.evidencecomprehensive.excel.converter.BaseConverter;
import com.sentum.evidencecomprehensive.domain.vo.resp.CdeResponse;
import org.mapstruct.Mapper;
import org.mapstruct.factory.Mappers;

/**
 * Description:
 */
@Mapper(config = BaseConverter.class)
public interface CdeEsDtoToBoConverter extends BaseBoEsDtoConverter<CdeResponse, CdeIndex> {

    CdeEsDtoToBoConverter INSTANCE = Mappers.getMapper(CdeEsDtoToBoConverter.class);
}
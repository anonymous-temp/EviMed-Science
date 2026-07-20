package com.sentum.evidencecomprehensive.excel.converter.service;

import com.sentum.evidencecomprehensive.excel.converter.BaseConverter;

import java.util.List;

/**
 * @param <Vo>
 * @param <CdeIndex>
 */
public interface BaseBoEsDtoConverter<Vo, CdeIndex> extends BaseConverter {

    CdeIndex voToEsDto(Vo vo);

    Vo esDtoToVo(CdeIndex cdeIndex);

    List<Vo> esDtoListToVoList(List<CdeIndex> cdeIndexList);

    List<CdeIndex> voListToEsDtoList(List<Vo> voList);
}

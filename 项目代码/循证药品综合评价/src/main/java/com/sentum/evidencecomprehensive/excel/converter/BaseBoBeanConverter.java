package com.sentum.evidencecomprehensive.excel.converter;

import java.util.List;

/**
 * bo to bean  
 * @param <Bo>
 * @param <Bean>
 */
public interface BaseBoBeanConverter<Bo, Bean> extends BaseConverter {

    Bean boToBean(Bo t);

    Bo beanToBo(Bean bo);

    List<Bo> beanListToBoList(List<Bean> beanList);

    List<Bean> boListToBeanList(List<Bo> boList);
}

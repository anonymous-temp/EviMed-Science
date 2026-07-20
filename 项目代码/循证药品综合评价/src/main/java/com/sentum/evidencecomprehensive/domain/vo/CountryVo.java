package com.sentum.evidencecomprehensive.domain.vo;

import io.swagger.annotations.ApiModel;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Description: 
 */
@Data
@ApiModel("搜索栏-国家返回实体")
@NoArgsConstructor
@AllArgsConstructor
public class CountryVo {
    /**
     * 国家全称
     */
    private String name;
    /**
     * 对应的查询数量
     */
    private Long count;
}

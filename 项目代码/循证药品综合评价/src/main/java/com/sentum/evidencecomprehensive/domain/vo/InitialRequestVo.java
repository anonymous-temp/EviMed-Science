package com.sentum.evidencecomprehensive.domain.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

/**
 * Description: 首页弹框 初始数据 请求实体类
 */
@Data
@ApiModel(value = "首页弹框 初始数据 请求实体类")
public class InitialRequestVo {
    @ApiModelProperty("课题id")
    private String id;
    @ApiModelProperty("用户输入的检索词")
    private String name;
    @ApiModelProperty("药品产品名称")
    private String drugName;
    @ApiModelProperty("商品名")
    private String commodityName;
    @ApiModelProperty("剂型")
    private String dosage;
    @ApiModelProperty("厂家")
    private String manufacturer;
    @ApiModelProperty("规格")
    private String specification;
    @ApiModelProperty("是否是第一次请求，点击决策报告时的第一次请求true，其他情况false")
    private boolean first;
    @ApiModelProperty("确认按钮")
    private boolean confirm;
}

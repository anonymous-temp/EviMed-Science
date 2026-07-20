package com.sentum.evidencecomprehensive.domain.vo.req;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

/**
 * Description: cde 请求实体类
 */

@Data
@ApiModel("cde 查询实体类")
public class CdeRequest {
    @ApiModelProperty("检索 id")
    private String id;
    @ApiModelProperty("操作类型 0默认 1纳入")
    private Integer operateType = 0;
    @ApiModelProperty("搜索框")
    private String searchCon;
    @ApiModelProperty("受理号")
    private String acceptid;
    @ApiModelProperty("药品名称")
    private String drgnamecn;
    @ApiModelProperty("企业名称")
    private String companys;
    @ApiModelProperty("承办日期排序，0 倒序， 1正序")
    private Integer dateSort;
    @ApiModelProperty("分页-每页大小默认10")
    private Integer pageSize = 10;
    @ApiModelProperty("分页-当前页数默认1")
    private Integer pageNum = 1;
}

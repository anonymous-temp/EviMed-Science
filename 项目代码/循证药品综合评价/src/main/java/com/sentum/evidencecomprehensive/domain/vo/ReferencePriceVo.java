package com.sentum.evidencecomprehensive.domain.vo;

import com.alibaba.fastjson.JSONObject;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * Description: 获取参考价格返回实体类
 */
@Data
@ApiModel("获取参考价格返回实体类")
@NoArgsConstructor
@AllArgsConstructor
public class ReferencePriceVo {
    
    @ApiModelProperty("pico之i，待评价药品-包含参考价格")
    private List<JSONObject> i;
    @ApiModelProperty("pico之c，对比药品-包含参考价格")
    private List<JSONObject> c;
}

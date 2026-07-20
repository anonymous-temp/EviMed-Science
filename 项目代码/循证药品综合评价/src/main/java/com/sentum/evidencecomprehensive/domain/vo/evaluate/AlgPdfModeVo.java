package com.sentum.evidencecomprehensive.domain.vo.evaluate;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

/**
 * Description: 质量评价中 每个 mode 实体
 */
@Data
@ApiModel(value = "质量评价中 每个 mode 实体")
public class AlgPdfModeVo {

    @ApiModelProperty("模块 id")
    private String modeId;

    @ApiModelProperty("标题")
    private String title;

    @ApiModelProperty("标题悬停提示，只有 meta 有")
    private String titleTips;

    @ApiModelProperty("每个模块的解析内容")
    private JSONArray body;

    @ApiModelProperty("原因，小叹号")
    private String reason;

    @ApiModelProperty("质量评价结果")
    private String predict;
}

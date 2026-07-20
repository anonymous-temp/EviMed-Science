package com.sentum.evidencecomprehensive.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 说明书的显示vo类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("文献的显示vo类")
public class InstructionVo {
    @ApiModelProperty("说明书标准名称-中文")
    private String simpleGenericName = "";
    @ApiModelProperty("说明书标准名称-英文")
    private String simpleEnglishName = "";
    @ApiModelProperty("说明书商品名称")
    private String simpleTradeName = "";
    @ApiModelProperty("说明书的适应症")
    private String indication = "暂无";
    @ApiModelProperty("厂家名称")
    private String enterpriseName = "";
    @ApiModelProperty("说明书发表日期")
    private String date = "暂无";
    @ApiModelProperty("说明书来源")
    private String source = "";
    @ApiModelProperty("说明书pdf")
    private String pdfName = "";
    @ApiModelProperty("修订日期")
    private String updateTime = "";
    private Boolean medicineUsePdf = false;
    //@ApiModelProperty("收藏标记，1-已收藏，0-未收藏")
    //private Integer collectionMark = 0;
}

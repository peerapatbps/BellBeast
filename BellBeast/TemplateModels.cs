public sealed class TemplateSaveRequest
{
    public string? name { get; set; }
    public List<TemplateItem>? items { get; set; }
}

public sealed class TemplateItem
{
    public int configparam_id { get; set; }
    public string? plant_en { get; set; }
    public string? station_name { get; set; }
    public string? Param_name { get; set; }
    public string? equipment_name { get; set; }
    public string? measure_th { get; set; }
}
